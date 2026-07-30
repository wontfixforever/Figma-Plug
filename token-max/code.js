figma.showUI(__html__, { width: 1280, height: 600 });

// 1. Refactor logic into a reusable function
async function loadVariables() {
  try {
    const collections = await figma.variables.getLocalVariableCollectionsAsync();

    const localVariables = await figma.variables.getLocalVariablesAsync();
    const fileName = figma.root.name;

    // Lookup + resolver for extended (extension) collections. Some Figma versions expose the
    // ExtendedVariableCollection metadata (isExtension / variableOverrides / parentVariableCollectionId
    // / modes[].parentModeId) but NOT Variable.getValuesByModeForCollectionAsync — so we rebuild
    // each extension-mode value ourselves: this level's override if present, else walk up the
    // parent chain (by parentModeId, or by mode name/index if that isn't exposed) to the base
    // variable's own valuesByMode.
    //
    // IMPORTANT: variableOverrides / modes / valuesByMode are native getters — every read
    // re-marshals the whole structure across the plugin sandbox boundary (deepWrap → newString).
    // Reading them per-variable-per-mode exhausts the JSVM heap and Figma kills the plugin with
    // "Plugin runtime aborted". Snapshot each collection ONCE here, then only read the snapshot.
    const colCache = {};
    collections.forEach(c => {
      colCache[c.id] = {
        id: c.id,
        name: c.name,
        isExtension: c.isExtension || false,
        parentId: c.parentVariableCollectionId || null,
        modes: (c.modes || []).map(m => ({ modeId: m.modeId, name: m.name, parentModeId: m.parentModeId || null })),
        overrides: c.variableOverrides || {}
      };
    });

    const resolveExtendedRaw = (varId, baseValues, startColId, startModeId) => {
      let meta = colCache[startColId];
      let modeId = startModeId;
      let guard = 0;
      while (meta && guard++ < 20) {
        const ov = meta.overrides[varId];
        if (ov && Object.prototype.hasOwnProperty.call(ov, modeId)) return ov[modeId];
        const parentMeta = meta.parentId ? colCache[meta.parentId] : null;
        if (!parentMeta) break;
        const modeIdx = meta.modes.findIndex(m => m.modeId === modeId);
        const mode = modeIdx >= 0 ? meta.modes[modeIdx] : null;
        let parentModeId = mode && mode.parentModeId;
        if (!parentModeId) {
          const pModes = parentMeta.modes;
          const byName = mode && pModes.find(pm => pm.name === mode.name);
          parentModeId = byName ? byName.modeId : (pModes[modeIdx] ? pModes[modeIdx].modeId : (pModes[0] && pModes[0].modeId));
        }
        if (!parentModeId) break;
        meta = parentMeta;
        modeId = parentModeId;
      }
      return baseValues ? baseValues[modeId] : undefined;
    };

    // Snapshot each local variable once (same native-getter caveat as the collections above).
    const varSnapshot = {};
    localVariables.forEach(v => {
      varSnapshot[v.id] = {
        id: v.id,
        name: v.name,
        resolvedType: v.resolvedType,
        variableCollectionId: v.variableCollectionId,
        valuesByMode: v.valuesByMode || {},
        scopes: v.scopes,
        hidden: v.hiddenFromPublishing || false
      };
    });

    // Memoize cross-file lookups. These were previously re-fetched per variable, per mode, per
    // alias hop — thousands of redundant async calls, each re-marshalling a collection.
    const extVarCache = {};
    const getExtVar = async (id) => {
      if (!Object.prototype.hasOwnProperty.call(extVarCache, id)) {
        let snap = null;
        try {
          const ev = await figma.variables.getVariableByIdAsync(id);
          if (ev) snap = { id: ev.id, name: ev.name, variableCollectionId: ev.variableCollectionId, valuesByMode: ev.valuesByMode || {} };
        } catch (e) { snap = null; }
        extVarCache[id] = snap;
      }
      return extVarCache[id];
    };

    const extColCache = {};
    const getExtCol = async (id) => {
      if (!Object.prototype.hasOwnProperty.call(extColCache, id)) {
        let snap = null;
        try {
          const ec = await figma.variables.getVariableCollectionByIdAsync(id);
          if (ec) snap = { name: ec.name, modes: (ec.modes || []).map(m => ({ modeId: m.modeId, name: m.name })) };
        } catch (e) { snap = null; }
        extColCache[id] = snap;
      }
      return extColCache[id];
    };

    const variableMap = {};

    // Map local variables for alias resolution
    Object.keys(varSnapshot).forEach(id => {
      const v = varSnapshot[id];
      const col = colCache[v.variableCollectionId];
      variableMap[id] = `${col ? col.name : "Unknown"}/${v.name}`;
    });

    // Resolve external library aliases
    for (const id in varSnapshot) {
      const values = varSnapshot[id].valuesByMode;
      for (const modeId in values) {
        const value = values[modeId];
        if (value && value.type === 'VARIABLE_ALIAS' && !variableMap[value.id]) {
          const externalVar = await getExtVar(value.id);
          if (externalVar) {
            const extCol = await getExtCol(externalVar.variableCollectionId);
            variableMap[value.id] = `${extCol ? extCol.name : "Library"}/${externalVar.name}`;
          } else {
            console.warn("Could not resolve external alias:", value.id);
          }
        }
      }
    }

    // Catalog alias targets referenced ONLY by extension overrides (they don't appear in any
    // base variable's valuesByMode), so aliasMap/export can name them instead of "unknown".
    for (const colId in colCache) {
      const meta = colCache[colId];
      if (!meta.isExtension) continue;
      for (const ovVarId in meta.overrides) {
        const modeVals = meta.overrides[ovVarId];
        for (const mId in modeVals) {
          const value = modeVals[mId];
          if (value && value.type === 'VARIABLE_ALIAS' && !variableMap[value.id]) {
            const av = await getExtVar(value.id);
            if (av) {
              const ac = await getExtCol(av.variableCollectionId);
              variableMap[value.id] = `${ac ? ac.name : 'Library'}/${av.name}`;
            } else {
              console.warn("Could not resolve extension-override alias:", value.id);
            }
          }
        }
      }
    }

    // Prep data for UI
    const dataForUi = await Promise.all(collections.map(async (collection) => {
      const meta = colCache[collection.id];
      const modes = meta.modes;
      const variableIds = collection.variableIds;

      const processedVars = await Promise.all(variableIds.map(async (varId) => {
        try {
          const v = varSnapshot[varId];
          if (!v) return null;

          // A variable's own valuesByMode is keyed by its DEFINING collection's modeIds. For an
          // extension that's the parent's modeIds, so cells keyed by the extension's own modes
          // come back empty — rebuild them below via resolveExtendedRaw.
          const baseValues = v.valuesByMode;
          let effectiveValues = baseValues;
          const overriddenByMode = {};
          if (meta.isExtension) {
            // Extension variables inherit the parent's modeIds; rebuild values keyed by THIS
            // collection's modes (override at this level, else inherited up the parent chain).
            effectiveValues = {};
            const overrides = meta.overrides[varId] || {};
            modes.forEach(m => {
              overriddenByMode[m.modeId] = Object.prototype.hasOwnProperty.call(overrides, m.modeId);
              effectiveValues[m.modeId] = resolveExtendedRaw(varId, baseValues, collection.id, m.modeId);
            });
          }

          // Helper function to resolve color values
          const resolveColorForMode = async (modeIdx) => {
            if (v.resolvedType !== 'COLOR' || !modes[modeIdx]) return null;

            let currentVal = effectiveValues[modes[modeIdx].modeId];
            let depth = 0;

            while (currentVal && currentVal.type === 'VARIABLE_ALIAS' && depth < 5) {
              const aliasVar = await getExtVar(currentVal.id);
              if (aliasVar) {
                const aliasCol = await getExtCol(aliasVar.variableCollectionId);
                const aModes = aliasCol ? aliasCol.modes : [];
                const target = aModes[modeIdx] || aModes[0];
                if (!target) break;

                currentVal = aliasVar.valuesByMode[target.modeId];
                depth++;
              } else {
                break;
              }
            }
            return currentVal;
          };

          const resolvedValues = {};

          if (v.resolvedType === 'COLOR') {
            for (let i = 0; i < modes.length; i++) {
              resolvedValues[modes[i].modeId] = await resolveColorForMode(i);
            }
          } else if (v.resolvedType === 'FLOAT') {
            for (let i = 0; i < modes.length; i++) {
              const mId = modes[i].modeId;
              let currentVal = effectiveValues[mId];
              if (currentVal && currentVal.type === 'VARIABLE_ALIAS') {
                let depth = 0;
                while (currentVal && currentVal.type === 'VARIABLE_ALIAS' && depth < 5) {
                  const aliasVar = await getExtVar(currentVal.id);
                  if (!aliasVar) break;
                  const aliasCol = await getExtCol(aliasVar.variableCollectionId);
                  const aModes = aliasCol ? aliasCol.modes : [];
                  const target = aModes[i] || aModes[0];
                  if (!target) break;
                  currentVal = aliasVar.valuesByMode[target.modeId];
                  depth++;
                }
                if (typeof currentVal === 'number') resolvedValues[mId] = currentVal;
              }
            }
          }

          return {
            id: v.id,
            name: v.name,
            type: v.resolvedType,
            valuesByMode: effectiveValues,
            scopes: v.scopes,
            resolvedValuesByMode: resolvedValues,
            overriddenByMode: overriddenByMode,
            hidden: v.hidden
          };

        } catch (varErr) {
          console.error("Error processing variable:", varId, varErr);
          return null;
        }
      }));

      return {
        id: meta.id,
        name: meta.name,
        modes: modes,
        isExtension: meta.isExtension,
        parentId: meta.isExtension ? meta.parentId : null,
        variables: processedVars.filter(v => v !== null)
      };
    }));

    // Send data to UI
    figma.ui.postMessage({
      type: 'load-data',
      collections: dataForUi,
      variableMap: variableMap,
      fileName: fileName
    });

  } catch (globalErr) {
    console.error("Plugin failed to run:", globalErr);
    figma.notify("Failed to load variables. Check the console.");
  }
}

// 2. Updated Message Handler
figma.ui.onmessage = async (msg) => {
  if (msg.type === 'ui-ready') {
    await loadVariables();
  }

  if (msg.type === 'refresh-variables') {
    await loadVariables();
    figma.notify("Variables refreshed");
  }

  if (msg.type === 'resize') {
    figma.ui.resize(msg.width, msg.height);
    if (msg.x !== undefined && msg.y !== undefined) {
      figma.ui.reposition(msg.x, msg.y);
    }
  }

  if (msg.type === 'get-theme') {
    const theme = await figma.clientStorage.getAsync('tokenmax-theme');
    figma.ui.postMessage({ type: 'load-theme', theme: theme || 'light' });
  }

  if (msg.type === 'set-theme') {
    await figma.clientStorage.setAsync('tokenmax-theme', msg.theme);
  }

  if (msg.type === 'get-tags') {
    const tags = await figma.clientStorage.getAsync('tokenmax-tags');
    figma.ui.postMessage({ type: 'load-tags', tags: tags || [] });
  }

  if (msg.type === 'set-tags') {
    await figma.clientStorage.setAsync('tokenmax-tags', msg.tags);
  }
};

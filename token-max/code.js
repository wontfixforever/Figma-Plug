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
    const collectionById = {};
    collections.forEach(c => { collectionById[c.id] = c; });

    const resolveExtendedRaw = (v, startCol, startModeId) => {
      let col = startCol;
      let modeId = startModeId;
      let guard = 0;
      while (col && guard++ < 20) {
        const ov = col.variableOverrides && col.variableOverrides[v.id];
        if (ov && Object.prototype.hasOwnProperty.call(ov, modeId)) return ov[modeId];
        const parentCol = col.parentVariableCollectionId ? collectionById[col.parentVariableCollectionId] : null;
        if (!parentCol) break;
        const modeIdx = (col.modes || []).findIndex(m => m.modeId === modeId);
        const mode = modeIdx >= 0 ? col.modes[modeIdx] : null;
        let parentModeId = mode && mode.parentModeId;
        if (!parentModeId) {
          const pModes = parentCol.modes || [];
          const byName = mode && pModes.find(pm => pm.name === mode.name);
          parentModeId = byName ? byName.modeId : (pModes[modeIdx] ? pModes[modeIdx].modeId : (pModes[0] && pModes[0].modeId));
        }
        if (!parentModeId) break;
        col = parentCol;
        modeId = parentModeId;
      }
      return v.valuesByMode ? v.valuesByMode[modeId] : undefined;
    };

    const variableMap = {};

    // Map local variables for alias resolution
    localVariables.forEach(v => {
      const col = collections.find(c => c.id === v.variableCollectionId);
      const colName = col ? col.name : "Unknown";
      variableMap[v.id] = `${colName}/${v.name}`;
    });

    // Resolve external library aliases
    for (const v of localVariables) {
      for (const modeId in v.valuesByMode) {
        const value = v.valuesByMode[modeId];
        if (value && value.type === 'VARIABLE_ALIAS') {
          if (!variableMap[value.id]) {
            try {
              const externalVar = await figma.variables.getVariableByIdAsync(value.id);
              if (externalVar) {
                const extCol = await figma.variables.getVariableCollectionByIdAsync(externalVar.variableCollectionId);
                const extColName = extCol ? extCol.name : "Library";
                variableMap[value.id] = `${extColName}/${externalVar.name}`;
              }
            } catch (e) {
              console.warn("Could not resolve external alias:", value.id);
            }
          }
        }
      }
    }

    // Catalog alias targets referenced ONLY by extension overrides (they don't appear in any
    // base variable's valuesByMode), so aliasMap/export can name them instead of "unknown".
    for (const collection of collections) {
      if (!collection.isExtension || !collection.variableOverrides) continue;
      for (const ovVarId in collection.variableOverrides) {
        const modeVals = collection.variableOverrides[ovVarId];
        for (const mId in modeVals) {
          const value = modeVals[mId];
          if (value && value.type === 'VARIABLE_ALIAS' && !variableMap[value.id]) {
            try {
              const av = await figma.variables.getVariableByIdAsync(value.id);
              if (av) {
                const ac = await figma.variables.getVariableCollectionByIdAsync(av.variableCollectionId);
                variableMap[value.id] = `${ac ? ac.name : 'Library'}/${av.name}`;
              }
            } catch (e) {
              console.warn("Could not resolve extension-override alias:", value.id);
            }
          }
        }
      }
    }

    // Prep data for UI
    const dataForUi = await Promise.all(collections.map(async (collection) => {
      const processedVars = await Promise.all(collection.variableIds.map(async (varId) => {
        try {
          const v = localVariables.find(variable => variable.id === varId);
          if (!v) return null;

          // A variable's own valuesByMode is keyed by its DEFINING collection's modeIds. For an
          // extension that's the parent's modeIds, so cells keyed by the extension's own modes
          // come back empty — rebuild them below via resolveExtendedRaw.
          let effectiveValues = v.valuesByMode;
          const overriddenByMode = {};
          if (collection.isExtension) {
            // Extension variables inherit the parent's modeIds; rebuild values keyed by THIS
            // collection's modes (override at this level, else inherited up the parent chain).
            effectiveValues = {};
            const overrides = (collection.variableOverrides && collection.variableOverrides[v.id]) || {};
            collection.modes.forEach(m => {
              overriddenByMode[m.modeId] = Object.prototype.hasOwnProperty.call(overrides, m.modeId);
              effectiveValues[m.modeId] = resolveExtendedRaw(v, collection, m.modeId);
            });
          }

          // Helper function to resolve color values
          const resolveColorForMode = async (modeIdx) => {
            if (v.resolvedType !== 'COLOR' || !collection.modes[modeIdx]) return null;
            
            let currentVal = effectiveValues[collection.modes[modeIdx].modeId];
            let depth = 0; 
            
            while (currentVal && currentVal.type === 'VARIABLE_ALIAS' && depth < 5) {
              const aliasVar = await figma.variables.getVariableByIdAsync(currentVal.id);
              if (aliasVar) {
                const aliasCol = await figma.variables.getVariableCollectionByIdAsync(aliasVar.variableCollectionId);
                
                let targetModeId;
                if (aliasCol.modes && aliasCol.modes[modeIdx]) {
                  targetModeId = aliasCol.modes[modeIdx].modeId;
                } else {
                  targetModeId = aliasCol.modes[0].modeId;
                }
                
                currentVal = aliasVar.valuesByMode[targetModeId];
                depth++;
              } else { 
                break; 
              }
            }
            return currentVal;
          };

          const resolvedValues = {};
          
          if (v.resolvedType === 'COLOR') {
            for (let i = 0; i < collection.modes.length; i++) {
              const mId = collection.modes[i].modeId;
              resolvedValues[mId] = await resolveColorForMode(i);
            }
          } else if (v.resolvedType === 'FLOAT') {
            for (let i = 0; i < collection.modes.length; i++) {
              const mId = collection.modes[i].modeId;
              let currentVal = effectiveValues[mId];
              if (currentVal && currentVal.type === 'VARIABLE_ALIAS') {
                let depth = 0;
                while (currentVal && currentVal.type === 'VARIABLE_ALIAS' && depth < 5) {
                  try {
                    const aliasVar = await figma.variables.getVariableByIdAsync(currentVal.id);
                    if (aliasVar) {
                      const aliasCol = await figma.variables.getVariableCollectionByIdAsync(aliasVar.variableCollectionId);
                      const targetModeId = (aliasCol.modes[i] || aliasCol.modes[0]).modeId;
                      currentVal = aliasVar.valuesByMode[targetModeId];
                    } else { break; }
                  } catch (e) { break; }
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
            hidden: v.hiddenFromPublishing || false
          };
          
        } catch (varErr) {
          console.error("Error processing variable:", varId, varErr);
          return null;
        }
      }));

      return {
        id: collection.id,
        name: collection.name,
        modes: collection.modes,
        isExtension: collection.isExtension || false,
        parentId: collection.isExtension ? collection.parentVariableCollectionId : null,
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
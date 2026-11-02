figma.showUI(__html__, { width: 1280, height: 600 });

// Collection Swap target list — computed once per plugin run (see get-swap-collections)
let swapCollectionsCache = null;

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

  if (msg.type === 'get-svg-suffixes') {
    const suffixes = await figma.clientStorage.getAsync('tokenmax-svg-suffixes');
    figma.ui.postMessage({ type: 'load-svg-suffixes', suffixes: suffixes || [] });
  }

  if (msg.type === 'set-svg-suffixes') {
    await figma.clientStorage.setAsync('tokenmax-svg-suffixes', msg.suffixes);
  }

  if (msg.type === 'get-svg-selection') {
    const vectorNodes = await buildSelectionPreviews();
    figma.ui.postMessage({ type: 'svg-selection', nodes: vectorNodes });
  }

  // Collection Swap tab uses the same selection detection as the SVG tab
  if (msg.type === 'get-swap-selection') {
    const vectorNodes = await buildSelectionPreviews();
    figma.ui.postMessage({ type: 'swap-selection', nodes: vectorNodes });
  }

  // Candidate swap targets: every token-owning collection reachable from this file
  if (msg.type === 'get-swap-collections') {
    if (swapCollectionsCache) {
      figma.ui.postMessage({
        type: 'swap-collections',
        options: swapCollectionsCache.options,
        libraryError: swapCollectionsCache.libraryError
      });
      return;
    }

    const options = [];
    const seenKeys = {};
    let libraryError = null;

    // Only collections that actually OWN colour tokens can be swap targets.
    // Extension collections (white labels) hold variableOverrides, not variables, so
    // they report zero — which is also the only way to spot them here, since
    // LibraryVariableCollection exposes no isExtension flag. The same test drops
    // empty/deprecated collections and non-colour ones (shape, font, radius).
    const localColorCount = {};
    (await figma.variables.getLocalVariablesAsync('COLOR')).forEach(v => {
      localColorCount[v.variableCollectionId] = (localColorCount[v.variableCollectionId] || 0) + 1;
    });

    const localCollections = await figma.variables.getLocalVariableCollectionsAsync();
    for (const c of localCollections) {
      if (c.isExtension) continue;
      if (!localColorCount[c.id]) continue;
      options.push({ value: 'local:' + c.id, label: c.name, source: 'This file' });
      if (c.key) seenKeys[c.key] = true;
    }

    try {
      const libCollections = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();

      // Probe every candidate at once. Sequentially this was ~60 round-trips and the UI
      // rendered its dropdowns before the answer arrived. LibraryVariable is flat
      // metadata ({key,name,resolvedType}), so this is safe to parallelise — unlike
      // variableOverrides/valuesByMode, which must stay one-at-a-time (JSVM heap).
      const probes = await Promise.all(libCollections.map(async (lc) => {
        if (seenKeys[lc.key]) return { lc, skip: true };
        try {
          const libVars = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(lc.key);
          return { lc, hasColorTokens: libVars.some(lv => lv.resolvedType === 'COLOR') };
        } catch (e) {
          return { lc, hasColorTokens: false };
        }
      }));

      const hidden = [];
      for (const p of probes) {
        if (p.skip) continue;
        if (!p.hasColorTokens) { hidden.push(p.lc.name); continue; }
        if (seenKeys[p.lc.key]) continue;
        seenKeys[p.lc.key] = true;
        options.push({
          value: 'lib:' + p.lc.key,
          label: p.lc.name,
          source: p.lc.libraryName || 'Library'
        });
      }
      console.log('[TokenMAX] swap targets:', options.length,
        '| hidden (no colour tokens of their own):', hidden.length, hidden.join(', '));
    } catch (e) {
      console.warn('Team library collections unavailable:', e);
      libraryError = 'Library collections could not be listed.';
    }

    // Cache for the rest of the plugin run — re-entering the tab is then instant
    swapCollectionsCache = { options, libraryError };
    figma.ui.postMessage({ type: 'swap-collections', options, libraryError });
  }

  // Every color token bound across the selected nodes, grouped by parent collection.
  // Each group also carries the nodes that actually use it, so the panel can show a
  // per-collection preview and a swap can target exactly those objects.
  if (msg.type === 'get-node-color-tokens') {
    const ids = msg.ids || (msg.id ? [msg.id] : []);
    if (ids.length === 0) {
      figma.ui.postMessage({ type: 'node-color-tokens', ids: ids, groups: [] });
      return;
    }

    const localVariables = await figma.variables.getLocalVariablesAsync();
    const localCollections = await figma.variables.getLocalVariableCollectionsAsync();

    const colCache = {};
    localCollections.forEach(c => { colCache[c.id] = c; });
    const varCache = {};
    localVariables.forEach(v => { varCache[v.id] = v; });

    const variableMap = {};
    localVariables.forEach(v => {
      const col = colCache[v.variableCollectionId];
      variableMap[v.id] = `${col ? col.name : 'Unknown'}/${v.name}`;
    });

    // Group by the root parent collection — extension collections roll up to their parent
    const groupsById = {};
    const seenPerGroup = {}; // groupId -> { varId: token }, so tokens dedupe across nodes

    for (const nodeId of ids) {
      const node = await figma.getNodeByIdAsync(nodeId);
      if (!node) continue;

      const bindings = await collectColorBindings(node, variableMap, []);

      for (const b of bindings) {
        let v = varCache[b.varId];
        if (!v) {
          try {
            v = await figma.variables.getVariableByIdAsync(b.varId);
            if (v) varCache[b.varId] = v;
          } catch (e) {}
        }

        const ownCol = v ? await fetchCollection(v.variableCollectionId, colCache) : null;
        const rootCol = ownCol ? await resolveRootCollection(ownCol, colCache) : null;
        const groupId = rootCol ? rootCol.id : 'unknown';

        if (!groupsById[groupId]) {
          groupsById[groupId] = {
            id: groupId,
            name: rootCol ? rootCol.name : 'Unknown Collection',
            // Matches the `value` of one of the get-swap-collections options, so the
            // group's dropdown can default to the collection it already uses
            optionValue: rootCol
              ? (rootCol.remote && rootCol.key ? 'lib:' + rootCol.key : 'local:' + rootCol.id)
              : null,
            tokens: [],
            nodeIds: []
          };
          seenPerGroup[groupId] = {};
        }

        const group = groupsById[groupId];
        if (group.nodeIds.indexOf(nodeId) === -1) group.nodeIds.push(nodeId);

        // A token on both a fill and a stroke — or on several selected nodes — is one row
        const seen = seenPerGroup[groupId];
        if (seen[b.varId]) {
          if (seen[b.varId].properties.indexOf(b.property) === -1) {
            seen[b.varId].properties.push(b.property);
          }
          continue;
        }

        const token = {
          varId: b.varId,
          name: v ? v.name : b.varName.split('/').slice(1).join('/') || b.varName,
          fullName: b.varName,
          hex: b.hex,
          properties: [b.property],
          viaExtension: ownCol && ownCol.isExtension ? ownCol.name : null
        };
        seen[b.varId] = token;
        group.tokens.push(token);
      }
    }

    const groups = Object.keys(groupsById)
      .map(k => groupsById[k])
      .sort((a, b) => a.name.localeCompare(b.name));
    groups.forEach(g => g.tokens.sort((a, b) => a.name.localeCompare(b.name)));

    figma.ui.postMessage({ type: 'node-color-tokens', ids: ids, groups });
  }

  // Rebind every color token from one collection to the same-named token in another
  if (msg.type === 'apply-collection-swap') {
    const nodeIds = msg.nodeIds || [];
    const swaps = msg.swaps || [];

    if (nodeIds.length === 0 || swaps.length === 0) {
      figma.ui.postMessage({ type: 'swap-applied', ok: false, error: 'Nothing to swap.' });
      return;
    }

    const colCache = {};
    const varCache = {};
    (await figma.variables.getLocalVariableCollectionsAsync()).forEach(c => { colCache[c.id] = c; });
    (await figma.variables.getLocalVariablesAsync()).forEach(v => { varCache[v.id] = v; });

    // Build one name→variable resolver per target collection
    const plan = {};
    try {
      for (const swap of swaps) {
        plan[swap.fromCollectionId] = await buildSwapTargetResolver(swap.toValue, colCache);
      }
    } catch (e) {
      figma.ui.postMessage({ type: 'swap-applied', ok: false, error: e.message });
      return;
    }

    const stats = { swapped: 0, nodes: 0, missing: [], failed: [] };

    for (const id of nodeIds) {
      const node = await figma.getNodeByIdAsync(id);
      if (!node) continue;
      const before = stats.swapped;
      await swapNodeColorTokens(node, plan, colCache, varCache, stats);
      if (stats.swapped > before) stats.nodes++;
    }

    let notice = stats.swapped > 0
      ? `Swapped ${stats.swapped} token binding${stats.swapped === 1 ? '' : 's'} across ${stats.nodes} object${stats.nodes === 1 ? '' : 's'}`
      : 'No token bindings were changed';
    if (stats.missing.length > 0) {
      notice += ` · ${stats.missing.length} token${stats.missing.length === 1 ? '' : 's'} had no counterpart`;
      console.warn('No same-named token in the target collection for:', stats.missing);
    }
    if (stats.failed.length > 0) {
      notice += ` · ${stats.failed.length} node${stats.failed.length === 1 ? '' : 's'} could not be written`;
    }
    figma.notify(notice, { error: stats.swapped === 0 || stats.failed.length > 0 });

    figma.ui.postMessage({
      type: 'swap-applied',
      ok: true,
      swapped: stats.swapped,
      nodes: stats.nodes,
      missing: stats.missing,
      failed: stats.failed
    });
  }

  // Analyze selected SVGs to find which color collections/modes are used
  if (msg.type === 'get-svg-color-collections') {
    const localCollections = await figma.variables.getLocalVariableCollectionsAsync();
    const localVariables = await figma.variables.getLocalVariablesAsync();

    // Build lookup maps for local data
    const colById = {};
    localCollections.forEach(c => { colById[c.id] = c; });
    const varById = {};
    localVariables.forEach(v => { varById[v.id] = v; });

    // Find all bound color variable IDs from selected nodes, plus every collection
    // the selection resolves against (surfaces remote extension collections)
    const boundVarIds = new Set();
    const modeColIds = new Set();
    for (const id of msg.ids) {
      const node = await figma.getNodeByIdAsync(id);
      if (node) {
        await collectBoundVariableIds(node, boundVarIds, modeColIds);
      }
    }

    // Find which collections contain these variables (including external library variables)
    const usedCollectionIds = new Set();
    for (const varId of boundVarIds) {
      let v = varById[varId];

      // If not in local variables, try to fetch from library
      if (!v) {
        try {
          v = await figma.variables.getVariableByIdAsync(varId);
        } catch (e) {
          console.warn('Could not fetch variable:', varId, e);
        }
      }

      if (v && v.resolvedType === 'COLOR') {
        usedCollectionIds.add(v.variableCollectionId);
        // Cache the variable for later use
        if (!varById[varId]) varById[varId] = v;
      }
    }

    // Fetch external collections and add to lookup
    for (const colId of usedCollectionIds) {
      if (!colById[colId]) {
        try {
          const col = await figma.variables.getVariableCollectionByIdAsync(colId);
          if (col) colById[colId] = col;
        } catch (e) {
          console.warn('Could not fetch collection:', colId, e);
        }
      }
    }

    // Build collection tree: find parent collections and extensions
    const relevantCollections = [];
    const processedIds = new Set();

    async function addCollectionWithExtensions(colId) {
      if (processedIds.has(colId)) return;
      let col = colById[colId];

      // Try to fetch if not in cache
      if (!col) {
        try {
          col = await figma.variables.getVariableCollectionByIdAsync(colId);
          if (col) colById[colId] = col;
        } catch (e) {
          console.warn('Could not fetch collection:', colId, e);
          return;
        }
      }
      if (!col) return;

      processedIds.add(colId);

      // Add parent first if this is an extension
      if (col.isExtension && col.parentVariableCollectionId) {
        await addCollectionWithExtensions(col.parentVariableCollectionId);
      }

      relevantCollections.push({
        id: col.id,
        name: col.name,
        modes: col.modes.map(m => ({ modeId: m.modeId, name: m.name })),
        isExtension: col.isExtension || false,
        parentId: col.parentVariableCollectionId || null
      });

      // Add any local extensions of this collection (recursively)
      for (const c of localCollections) {
        if (c.isExtension && c.parentVariableCollectionId === colId && !processedIds.has(c.id)) {
          await addCollectionWithExtensions(c.id);
        }
      }
    }

    for (const colId of usedCollectionIds) {
      await addCollectionWithExtensions(colId);
    }

    // Also check all local collections for any extensions of the collections we found
    // (in case they weren't caught by the recursive search)
    for (const col of localCollections) {
      if (col.isExtension && !processedIds.has(col.id)) {
        // Check if this extends any collection we've already added
        const parentInList = relevantCollections.some(rc => rc.id === col.parentVariableCollectionId);
        if (parentInList) {
          await addCollectionWithExtensions(col.id);
        }
      }
    }

    // Extensions owned by another library can't be found by scanning localCollections,
    // and they never show up as a variable's own collection either — extensions hold no
    // variables, only mode overrides, so v.variableCollectionId is always the parent.
    // resolvedVariableModes is the one place their IDs surface.
    async function fetchCol(colId) {
      if (colById[colId]) return colById[colId];
      try {
        const col = await figma.variables.getVariableCollectionByIdAsync(colId);
        if (col) colById[colId] = col;
        return col || null;
      } catch (e) {
        return null;
      }
    }

    // Only keep extensions that hang off a collection the selection actually uses —
    // resolvedVariableModes also lists unrelated collections (radius, spacing, type).
    async function extendsAUsedCollection(col) {
      let current = col;
      const guard = new Set();
      while (current && current.parentVariableCollectionId && !guard.has(current.id)) {
        guard.add(current.id);
        const parentId = current.parentVariableCollectionId;
        if (usedCollectionIds.has(parentId) || processedIds.has(parentId)) return true;
        current = await fetchCol(parentId);
      }
      return false;
    }

    for (const colId of modeColIds) {
      if (processedIds.has(colId)) continue;
      const col = await fetchCol(colId);
      if (!col || !col.isExtension) continue;
      if (await extendsAUsedCollection(col)) {
        await addCollectionWithExtensions(colId);
      }
    }

    console.log('[TokenMAX] SVG collections:', relevantCollections.map(c => c.name + (c.isExtension ? ' (ext)' : '')).join(', ') || '(none)');


    figma.ui.postMessage({ type: 'svg-color-collections', collections: relevantCollections });
  }

  if (msg.type === 'export-svg') {
    resetOverridesSnapshot();
    const svgPreset = msg.svgPreset || 'Token';  // 'Token' = token names, 'Web' = CSS vars, 'Hex' = flat hex
    const suffixes = msg.suffixes || [];
    // Collection and Mode aren't part of the tag chain — they sit directly in front of
    // the mode segment within modeSuffix, so they're separate flags rather than suffix
    // strings. Mode is TokenHex-only (see includeModeTag usage below).
    const includeCollectionTag = !!msg.includeCollectionTag;
    const includeModeTag = !!msg.includeModeTag;
    const modeSelections = msg.modeSelections || []; // Array of {colId, modeId, colName, modeName}
    const exports = [];

    const localVariables = await figma.variables.getLocalVariablesAsync();
    const localCollections = await figma.variables.getLocalVariableCollectionsAsync();

    // Build caches that will be populated as needed (includes library data)
    const colCache = {};
    localCollections.forEach(c => { colCache[c.id] = c; });
    const varCache = {};
    localVariables.forEach(v => { varCache[v.id] = v; });

    // Build colMap for naming (local only initially)
    const colMap = {};
    localCollections.forEach(c => { colMap[c.id] = c.name; });

    let variableMap = {};
    localVariables.forEach(v => {
      variableMap[v.id] = `${colMap[v.variableCollectionId] || 'Unknown'}/${v.name}`;
    });

    // Build suffix string: lowercase, hyphen-separated
    const suffixStr = suffixes.length > 0
      ? '-' + suffixes.map(s => s.toLowerCase().replace(/\s+/g, '-')).join('-')
      : '';

    for (const id of msg.ids) {
      const node = await figma.getNodeByIdAsync(id);
      if (node && canExportAsSvg(node)) {
        try {
          const baseName = node.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

          // If mode selections provided, export one file per selection
          if (modeSelections.length > 0) {
            // Collect bindings once for this node
            const bindings = await collectColorBindings(node, variableMap, []);

            // Check node's resolved variable modes to find what's actually being used for rendering
            let resolvedModes = {};
            if ('resolvedVariableModes' in node) {
              resolvedModes = node.resolvedVariableModes || {};
            }

            for (const sel of modeSelections) {

              let svgString = await node.exportAsync({ format: 'SVG_STRING' });

              if (svgPreset === 'Web') {
                // Web (Legacy) preset: use CSS vars with mode-resolved fallbacks
                const hexToVarMap = {};
                for (const b of bindings) {
                  const resolvedColor = await resolveColorForMode(
                    b.varId, sel.colId, sel.modeId, colCache, varCache
                  );
                  const hexKey = b.hex.toUpperCase();
                  if (!hexToVarMap[hexKey]) {
                    hexToVarMap[hexKey] = {
                      cssVar: tokenNameToCssVar(b.varName),
                      fallback: resolvedColor ? rgbToHex(resolvedColor) : b.hex
                    };
                  }
                }
                svgString = replaceSvgHexWithCssVars(svgString, hexToVarMap);
              } else if (svgPreset === 'Token') {
                // Token preset: token names only (e.g., fill="SurfaceContainer")
                const hexToTokenMap = {};
                for (const b of bindings) {
                  const hexKey = b.hex.toUpperCase();
                  if (!hexToTokenMap[hexKey]) {
                    hexToTokenMap[hexKey] = tokenNameToRaw(b.varName);
                  }
                }
                svgString = replaceSvgHexWithTokenNames(svgString, hexToTokenMap);
              } else if (svgPreset === 'TokenHex') {
                // Token + Hex preset: token names with hex fallback (e.g., fill="var(--SurfaceContainer, #000000)")
                // SVG export uses document's current appearance - which may be ANY mode in the parent
                // collection OR any extension collection. Resolve colors for ALL to find matches.
                const hexToTokenHexMap = {};

                // Get target collection and find all extension collections that inherit from it
                let targetCol = colCache[sel.colId];
                if (!targetCol) {
                  try {
                    const c = await figma.variables.getVariableCollectionByIdAsync(sel.colId);
                    if (c) {
                      targetCol = c;
                      colCache[sel.colId] = c;
                    }
                  } catch (e) {}
                }

                // Collect all collections to check: target + any extensions (including from
                // resolvedVariableModes). Stored as plain {id, modes} snapshots — `modes` is a
                // native getter, and the sweep below reads it once per token per collection.
                const collectionsToCheck = [];
                const addToCheck = (col) => {
                  if (!col || collectionsToCheck.find(c => c.id === col.id)) return;
                  collectionsToCheck.push({
                    id: col.id,
                    modes: (col.modes || []).map(m => ({ modeId: m.modeId }))
                  });
                };

                addToCheck(targetCol);

                // Find extension collections from local collections
                const allCollections = await figma.variables.getLocalVariableCollectionsAsync();
                for (const col of allCollections) {
                  if (col.isExtension && col.parentVariableCollectionId === sel.colId) {
                    colCache[col.id] = col;
                    addToCheck(col);
                  }
                }

                // Also check resolvedVariableModes for library extension collections
                for (const colId in resolvedModes) {
                  if (colId !== sel.colId && !collectionsToCheck.find(c => c.id === colId)) {
                    try {
                      const extCol = await figma.variables.getVariableCollectionByIdAsync(colId);
                      if (extCol) {
                        colCache[colId] = extCol;
                        addToCheck(extCol);
                      }
                    } catch (e) {}
                  }
                }

                // One entry per distinct token: an illustration can have 90+ paths sharing
                // a handful of tokens, and the mode sweep below is the expensive part.
                const uniqueBindings = [];
                const seenBindingVarIds = {};
                for (const b of bindings) {
                  if (seenBindingVarIds[b.varId]) continue;
                  seenBindingVarIds[b.varId] = true;
                  uniqueBindings.push(b);
                }

                // PASS 1 — a paint's own hex authoritatively identifies its token, so claim
                // every one of those keys first.
                //
                // Both passes write only into free keys, so ordering decides collisions. When
                // this was a single interleaved pass, one token's *other-mode* value could take
                // the key belonging to another token's *actual* colour: OnSurface's Dark value
                // is white, so it claimed #FFFFFF before Surface (white in Light) got there,
                // and every Surface path exported as var(--OnSurface, #16191F).
                const tokenDataByVarId = {};
                for (const b of uniqueBindings) {
                  const resolvedColor = await resolveColorForMode(
                    b.varId, sel.colId, sel.modeId, colCache, varCache
                  );
                  tokenDataByVarId[b.varId] = {
                    tokenName: tokenNameToRaw(b.varName),
                    fallback: resolvedColor ? rgbToHex(resolvedColor) : b.hex
                  };
                }
                for (const b of bindings) {
                  const currentKey = b.hex.toUpperCase();
                  if (!hexToTokenHexMap[currentKey]) {
                    hexToTokenHexMap[currentKey] = tokenDataByVarId[b.varId];
                  }
                }

                // PASS 2 — paint.color doesn't always match what the document renders (an
                // active extension resolves to different values), so add every mode of every
                // collection as a fallback key. Gap-filling only; pass 1 always wins.
                for (const b of uniqueBindings) {
                  const tokenData = tokenDataByVarId[b.varId];
                  for (const col of collectionsToCheck) {
                    for (const mode of col.modes) {
                      const modeColor = await resolveColorForMode(
                        b.varId, col.id, mode.modeId, colCache, varCache
                      );
                      if (!modeColor) continue;
                      const modeHex = rgbToHex(modeColor).toUpperCase();
                      if (!hexToTokenHexMap[modeHex]) {
                        hexToTokenHexMap[modeHex] = tokenData;
                      }
                    }
                  }
                }

                svgString = replaceSvgHexWithTokenNamesAndHex(svgString, hexToTokenHexMap);
              } else {
                // Hex preset: flat hex colors resolved to mode
                const hexToResolvedMap = {};
                for (const b of bindings) {
                  const resolvedColor = await resolveColorForMode(
                    b.varId, sel.colId, sel.modeId, colCache, varCache
                  );
                  if (resolvedColor) {
                    const hexKey = b.hex.toUpperCase();
                    hexToResolvedMap[hexKey] = rgbToHex(resolvedColor);
                  }
                }
                svgString = replaceSvgHexWithResolved(svgString, hexToResolvedMap);
              }

              // Build filename with mode suffix.
              // TokenHex: both Collection and Mode are opt-in tags, smashed into one
              // word each (no hyphens) and placed in that order — Collection then Mode
              // — directly in front of whatever tags follow. With both off, modeSuffix
              // is '' so the filename matches the Token preset's bare baseName+suffixStr.
              // Hex keeps the mode name unconditional (only Collection is opt-in) since
              // it can export multiple, genuinely different-colored files per mode —
              // dropping the mode name there would make filenames ambiguous. Web keeps
              // its original unconditional collection-mode naming — no tag toggles at all.
              const slugModeName = sel.modeName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
              const smashedModeName = sel.modeName.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
              let modeSuffix;
              if (svgPreset === 'TokenHex') {
                const smashedColName = sel.colName.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
                modeSuffix = (includeCollectionTag ? `-${smashedColName}` : '') + (includeModeTag ? `-${smashedModeName}` : '');
              } else if (svgPreset === 'Hex') {
                const smashedColName = sel.colName.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
                modeSuffix = (includeCollectionTag ? `-${smashedColName}` : '') + `-${slugModeName}`;
              } else {
                const slugColName = sel.colName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
                modeSuffix = `-${slugColName}-${slugModeName}`;
              }
              const exportName = baseName + modeSuffix + suffixStr;
              // colName travels with the export so the UI can group files into
              // per-collection zip folders when that's requested.
              exports.push({ id: node.id, name: exportName, svg: svgString, colName: sel.colName });
            }
          } else {
            // No mode selections - use original behavior
            let svgString = await node.exportAsync({ format: 'SVG_STRING' });

            if (svgPreset === 'Web') {
              const bindings = await collectColorBindings(node, variableMap, []);
              const hexToVarMap = {};
              for (const b of bindings) {
                const hexKey = b.hex.toUpperCase();
                if (!hexToVarMap[hexKey]) {
                  hexToVarMap[hexKey] = {
                    cssVar: tokenNameToCssVar(b.varName),
                    fallback: b.hex
                  };
                }
              }
              svgString = replaceSvgHexWithCssVars(svgString, hexToVarMap);
            } else if (svgPreset === 'Token') {
              const bindings = await collectColorBindings(node, variableMap, []);
              const hexToTokenMap = {};
              for (const b of bindings) {
                const hexKey = b.hex.toUpperCase();
                if (!hexToTokenMap[hexKey]) {
                  hexToTokenMap[hexKey] = tokenNameToRaw(b.varName);
                }
              }
              svgString = replaceSvgHexWithTokenNames(svgString, hexToTokenMap);
            } else if (svgPreset === 'TokenHex') {
              const bindings = await collectColorBindings(node, variableMap, []);
              const hexToTokenHexMap = {};
              for (const b of bindings) {
                const hexKey = b.hex.toUpperCase();
                if (!hexToTokenHexMap[hexKey]) {
                  hexToTokenHexMap[hexKey] = {
                    tokenName: tokenNameToRaw(b.varName),
                    fallback: b.hex
                  };
                }
              }
              svgString = replaceSvgHexWithTokenNamesAndHex(svgString, hexToTokenHexMap);
            }
            // Hex preset: no processing needed, keep raw hex

            const exportName = baseName + suffixStr;
            exports.push({ id: node.id, name: exportName, svg: svgString });
          }
        } catch (e) {
          console.warn('Failed to export SVG:', node.name, e);
        }
      }
    }
    figma.ui.postMessage({ type: 'svg-export-data', exports });
    if (exports.length > 0) {
      figma.notify(`Exported ${exports.length} SVG${exports.length > 1 ? 's' : ''}`);
    }
  }
};

function canExportAsSvg(node) {
  const exportableTypes = [
    'VECTOR', 'STAR', 'LINE', 'ELLIPSE', 'POLYGON', 'RECTANGLE',
    'FRAME', 'GROUP', 'COMPONENT', 'INSTANCE', 'BOOLEAN_OPERATION',
    'TEXT', 'SLICE'
  ];
  return exportableTypes.includes(node.type);
}

// Render the current Figma selection as SVG thumbnails.
// Shared by the SVG tab and the Collection Swap tab.
async function buildSelectionPreviews() {
  const previews = [];
  for (const node of figma.currentPage.selection) {
    if (!canExportAsSvg(node)) continue;
    try {
      const svgString = await node.exportAsync({ format: 'SVG_STRING' });
      previews.push({
        id: node.id,
        name: node.name,
        width: node.width,
        height: node.height,
        svg: svgString
      });
    } catch (e) {
      console.warn('Failed to export node as SVG:', node.name, e);
    }
  }
  return previews;
}

async function fetchCollection(colId, colCache) {
  if (!colId) return null;
  if (colCache[colId]) return colCache[colId];
  try {
    const col = await figma.variables.getVariableCollectionByIdAsync(colId);
    if (col) colCache[colId] = col;
    return col || null;
  } catch (e) {
    return null;
  }
}

// Walk up the extension chain to the collection that actually owns the tokens
async function resolveRootCollection(col, colCache) {
  let current = col;
  const guard = new Set();
  while (current && current.isExtension && current.parentVariableCollectionId && !guard.has(current.id)) {
    guard.add(current.id);
    const parent = await fetchCollection(current.parentVariableCollectionId, colCache);
    if (!parent) break;
    current = parent;
  }
  return current;
}

// --- Collection Swap Helpers ---

// Returns { label, get(tokenName) } for a swap target. `toValue` is either
// 'local:<collectionId>' for a collection in this file, or 'lib:<collectionKey>'
// for one published by a library (variables are imported on demand).
async function buildSwapTargetResolver(toValue, colCache) {
  if (toValue.indexOf('local:') === 0) {
    const colId = toValue.slice('local:'.length);
    const col = await fetchCollection(colId, colCache);
    const byName = {};
    const localColorVars = await figma.variables.getLocalVariablesAsync('COLOR');
    localColorVars.forEach(v => {
      if (v.variableCollectionId === colId) byName[v.name] = v;
    });
    if (Object.keys(byName).length === 0) {
      throw new Error(`"${col ? col.name : 'That collection'}" owns no colour tokens, so there is nothing to swap to.`);
    }
    return {
      label: col ? col.name : 'collection',
      get: async (tokenName) => byName[tokenName] || null
    };
  }

  const colKey = toValue.slice('lib:'.length);
  let libVars;
  try {
    libVars = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(colKey);
  } catch (e) {
    throw new Error('Could not read the target library collection. Make sure the library is enabled for this file.');
  }

  const keyByName = {};
  libVars.forEach(lv => {
    if (lv.resolvedType === 'COLOR') keyByName[lv.name] = lv.key;
  });
  // An extension/white-label collection lands here with zero variables of its own.
  // Without this the swap "succeeds" having changed nothing, reporting every token
  // as missing a counterpart — which is what made this fail silently before.
  if (Object.keys(keyByName).length === 0) {
    throw new Error('That collection owns no colour tokens. White-label collections hold overrides, not tokens, so they cannot be swap targets.');
  }

  const imported = {};
  return {
    label: 'library collection',
    get: async (tokenName) => {
      if (tokenName in imported) return imported[tokenName];
      const varKey = keyByName[tokenName];
      if (!varKey) {
        imported[tokenName] = null;
        return null;
      }
      try {
        imported[tokenName] = await figma.variables.importVariableByKeyAsync(varKey);
      } catch (e) {
        imported[tokenName] = null;
      }
      return imported[tokenName];
    }
  };
}

// Given a currently-bound variable, return the same-named variable in the target
// collection — or null if this token isn't being swapped / has no counterpart.
async function findSwapReplacement(varId, plan, colCache, varCache, stats) {
  let v = varCache[varId];
  if (!v) {
    try {
      v = await figma.variables.getVariableByIdAsync(varId);
      if (v) varCache[varId] = v;
    } catch (e) {}
  }
  if (!v) return null;

  const ownCol = await fetchCollection(v.variableCollectionId, colCache);
  const rootCol = ownCol ? await resolveRootCollection(ownCol, colCache) : null;
  if (!rootCol) return null;

  const target = plan[rootCol.id];
  if (!target) return null; // collection left unchanged in the panel

  const replacement = await target.get(v.name);
  if (!replacement) {
    if (stats.missing.indexOf(v.name) === -1) stats.missing.push(v.name);
    return null;
  }
  if (replacement.id === v.id) return null;

  stats.swapped++;
  return replacement;
}

function isGradientPaint(paint) {
  return paint.type === 'GRADIENT_LINEAR' || paint.type === 'GRADIENT_RADIAL' ||
         paint.type === 'GRADIENT_ANGULAR' || paint.type === 'GRADIENT_DIAMOND';
}

// Returns a rebound copy of `paints`, or null when nothing in them changed
async function rebindPaints(paints, plan, colCache, varCache, stats) {
  let changed = false;
  const out = [];

  for (const paint of paints) {
    let next = paint;

    if (paint.type === 'SOLID' && paint.boundVariables && paint.boundVariables.color && paint.boundVariables.color.id) {
      const replacement = await findSwapReplacement(paint.boundVariables.color.id, plan, colCache, varCache, stats);
      if (replacement) {
        next = figma.variables.setBoundVariableForPaint(paint, 'color', replacement);
        changed = true;
      }
    } else if (isGradientPaint(paint) && paint.gradientStops) {
      const stops = [];
      let stopsChanged = false;
      for (const stop of paint.gradientStops) {
        let nextStop = stop;
        if (stop.boundVariables && stop.boundVariables.color && stop.boundVariables.color.id) {
          const replacement = await findSwapReplacement(stop.boundVariables.color.id, plan, colCache, varCache, stats);
          if (replacement) {
            // setBoundVariableForPaint only accepts SolidPaint, so bind the stop's alias directly
            nextStop = Object.assign({}, stop, {
              boundVariables: Object.assign({}, stop.boundVariables, {
                color: { type: 'VARIABLE_ALIAS', id: replacement.id }
              })
            });
            stopsChanged = true;
          }
        }
        stops.push(nextStop);
      }
      if (stopsChanged) {
        next = Object.assign({}, paint, { gradientStops: stops });
        changed = true;
      }
    }

    out.push(next);
  }

  return changed ? out : null;
}

async function swapNodeColorTokens(node, plan, colCache, varCache, stats) {
  // A node can refuse the write (locked layer, read-only instance property).
  // Record it and keep going rather than aborting the whole batch.
  function write(apply, swappedBefore) {
    try {
      apply();
    } catch (e) {
      console.warn('Could not update', node.name, e);
      if (stats.failed.indexOf(node.name) === -1) stats.failed.push(node.name);
      stats.swapped = swappedBefore;
    }
  }

  if ('fills' in node && Array.isArray(node.fills)) {
    const swappedBefore = stats.swapped;
    const next = await rebindPaints(node.fills, plan, colCache, varCache, stats);
    if (next) write(() => { node.fills = next; }, swappedBefore);
  } else if ('fills' in node && typeof node.fills === 'symbol') {
    // Mixed fills (VECTOR with multiple colored paths): rebind each region's fills
    // and write the whole network back — assigning node.fills would flatten them.
    if ('vectorNetwork' in node && node.vectorNetwork && node.vectorNetwork.regions && node.vectorNetwork.regions.length > 0) {
      const network = JSON.parse(JSON.stringify(node.vectorNetwork));
      const swappedBefore = stats.swapped;
      let changed = false;
      for (const region of network.regions) {
        if (!Array.isArray(region.fills)) continue;
        const next = await rebindPaints(region.fills, plan, colCache, varCache, stats);
        if (next) {
          region.fills = next;
          changed = true;
        }
      }
      if (changed) {
        try {
          if (typeof node.setVectorNetworkAsync === 'function') {
            await node.setVectorNetworkAsync(network);
          } else {
            node.vectorNetwork = network;
          }
        } catch (e) {
          console.warn('Could not write vector network for', node.name, e);
          if (stats.failed.indexOf(node.name) === -1) stats.failed.push(node.name);
          stats.swapped = swappedBefore; // nothing actually landed on the node
        }
      }
    }
  }

  if ('strokes' in node && Array.isArray(node.strokes)) {
    const swappedBefore = stats.swapped;
    const next = await rebindPaints(node.strokes, plan, colCache, varCache, stats);
    if (next) write(() => { node.strokes = next; }, swappedBefore);
  }

  if ('children' in node) {
    for (const child of node.children) {
      await swapNodeColorTokens(child, plan, colCache, varCache, stats);
    }
  }
}

// --- SVG CSS Variable Export Helpers ---

function rgbToHex(color) {
  const toHex = (v) => {
    const h = Math.round(v * 255).toString(16);
    return h.length === 1 ? '0' + h : h;
  };
  return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`.toUpperCase();
}

function tokenNameToCssVar(tokenName) {
  // tokenName format: "CollectionName/Group/Variable Name"
  // We want just the variable name (last segment) with --lc- prefix
  const parts = tokenName.split('/');
  const varName = parts[parts.length - 1];

  const slug = varName
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return '--lc-' + slug;
}

function tokenNameToRaw(tokenName) {
  // tokenName format: "CollectionName/Group/Variable Name"
  // We want just the variable name (last segment) with spaces removed
  const parts = tokenName.split('/');
  const varName = parts[parts.length - 1];
  // Remove spaces between words, keep original casing
  return varName.replace(/\s+/g, '');
}

async function collectColorBindings(node, variableMap, bindings, depth = 0) {
  if (!bindings) bindings = [];

  // Helper to resolve variable name
  async function resolveVarName(varId) {
    let varName = variableMap[varId];
    if (!varName) {
      try {
        const v = await figma.variables.getVariableByIdAsync(varId);
        if (v) {
          const col = await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId);
          varName = `${col ? col.name : 'Library'}/${v.name}`;
        }
      } catch (e) {}
    }
    return varName;
  }

  // Helper to process paints (fills or strokes)
  async function processPaints(paints, property) {
    for (const paint of paints) {
      // Solid fills/strokes
      if (paint.type === 'SOLID' && paint.boundVariables?.color?.id) {
        const varId = paint.boundVariables.color.id;
        const varName = await resolveVarName(varId);
        if (varName) {
          const hex = rgbToHex(paint.color);
          bindings.push({ hex, varId, varName, property });
        }
      }
      // Gradient fills/strokes
      else if ((paint.type === 'GRADIENT_LINEAR' || paint.type === 'GRADIENT_RADIAL' || paint.type === 'GRADIENT_ANGULAR' || paint.type === 'GRADIENT_DIAMOND') && paint.gradientStops) {
        for (const stop of paint.gradientStops) {
          if (stop.boundVariables?.color?.id) {
            const varId = stop.boundVariables.color.id;
            const varName = await resolveVarName(varId);
            if (varName) {
              const hex = rgbToHex(stop.color);
              bindings.push({ hex, varId, varName, property: 'stop-color' });
            }
          }
        }
      }
    }
  }

  if ('fills' in node && Array.isArray(node.fills)) {
    await processPaints(node.fills, 'fill');
  } else if ('fills' in node && typeof node.fills === 'symbol') {
    // Mixed fills (e.g., VECTOR with multiple colored paths) - check vectorNetwork.regions
    if ('vectorNetwork' in node && node.vectorNetwork && node.vectorNetwork.regions) {
      for (const region of node.vectorNetwork.regions) {
        if (region.fills && Array.isArray(region.fills)) {
          await processPaints(region.fills, 'fill');
        }
      }
    }
  }

  if ('strokes' in node && Array.isArray(node.strokes)) {
    await processPaints(node.strokes, 'stroke');
  }

  if ('children' in node) {
    for (const child of node.children) {
      await collectColorBindings(child, variableMap, bindings, depth + 1);
    }
  }

  return bindings;
}

// Map of hex values to CSS color keywords that Figma might output
const HEX_TO_COLOR_NAME = {
  'FFFFFF': 'white',
  '000000': 'black',
  'FF0000': 'red',
  '00FF00': 'lime',
  '0000FF': 'blue',
  'FFFF00': 'yellow',
  '00FFFF': 'cyan',
  'FF00FF': 'magenta',
  '808080': 'gray',
  'C0C0C0': 'silver',
  '800000': 'maroon',
  '808000': 'olive',
  '008000': 'green',
  '800080': 'purple',
  '008080': 'teal',
  '000080': 'navy'
};

function replaceSvgHexWithCssVars(svgString, hexToVarMap) {
  let result = svgString;

  for (const hex in hexToVarMap) {
    const { cssVar, fallback } = hexToVarMap[hex];
    const escapedHex = hex.replace('#', '');
    const colorName = HEX_TO_COLOR_NAME[escapedHex.toUpperCase()];
    const replacement = `var(${cssVar}, ${fallback})`;

    // Replace hex values in fill/stroke attributes
    const fillAttrRegex = new RegExp(`(fill=["'])#?${escapedHex}(["'])`, 'gi');
    result = result.replace(fillAttrRegex, `$1${replacement}$2`);

    const strokeAttrRegex = new RegExp(`(stroke=["'])#?${escapedHex}(["'])`, 'gi');
    result = result.replace(strokeAttrRegex, `$1${replacement}$2`);

    // Replace hex values in gradient stop-color attributes
    const stopColorAttrRegex = new RegExp(`(stop-color=["'])#?${escapedHex}(["'])`, 'gi');
    result = result.replace(stopColorAttrRegex, `$1${replacement}$2`);

    // Replace hex values in inline styles
    const styleFillRegex = new RegExp(`(fill:\\s*)#?${escapedHex}`, 'gi');
    result = result.replace(styleFillRegex, `$1${replacement}`);

    const styleStrokeRegex = new RegExp(`(stroke:\\s*)#?${escapedHex}`, 'gi');
    result = result.replace(styleStrokeRegex, `$1${replacement}`);

    const styleStopColorRegex = new RegExp(`(stop-color:\\s*)#?${escapedHex}`, 'gi');
    result = result.replace(styleStopColorRegex, `$1${replacement}`);

    // Also replace CSS color keyword if applicable
    if (colorName) {
      const fillNameRegex = new RegExp(`(fill=["'])${colorName}(["'])`, 'gi');
      result = result.replace(fillNameRegex, `$1${replacement}$2`);

      const strokeNameRegex = new RegExp(`(stroke=["'])${colorName}(["'])`, 'gi');
      result = result.replace(strokeNameRegex, `$1${replacement}$2`);

      const stopColorNameRegex = new RegExp(`(stop-color=["'])${colorName}(["'])`, 'gi');
      result = result.replace(stopColorNameRegex, `$1${replacement}$2`);

      const styleFillNameRegex = new RegExp(`(fill:\\s*)${colorName}(?![a-z])`, 'gi');
      result = result.replace(styleFillNameRegex, `$1${replacement}`);

      const styleStrokeNameRegex = new RegExp(`(stroke:\\s*)${colorName}(?![a-z])`, 'gi');
      result = result.replace(styleStrokeNameRegex, `$1${replacement}`);

      const styleStopColorNameRegex = new RegExp(`(stop-color:\\s*)${colorName}(?![a-z])`, 'gi');
      result = result.replace(styleStopColorNameRegex, `$1${replacement}`);
    }
  }

  return result;
}

function replaceSvgHexWithTokenNames(svgString, hexToTokenMap) {
  let result = svgString;

  for (const hex in hexToTokenMap) {
    const tokenName = hexToTokenMap[hex];
    const escapedHex = hex.replace('#', '');
    const colorName = HEX_TO_COLOR_NAME[escapedHex.toUpperCase()];

    // Replace hex values with token name in fill/stroke attributes
    const fillAttrRegex = new RegExp(`(fill=["'])#?${escapedHex}(["'])`, 'gi');
    result = result.replace(fillAttrRegex, `$1${tokenName}$2`);

    const strokeAttrRegex = new RegExp(`(stroke=["'])#?${escapedHex}(["'])`, 'gi');
    result = result.replace(strokeAttrRegex, `$1${tokenName}$2`);

    // Replace hex values in gradient stop-color attributes
    const stopColorAttrRegex = new RegExp(`(stop-color=["'])#?${escapedHex}(["'])`, 'gi');
    result = result.replace(stopColorAttrRegex, `$1${tokenName}$2`);

    // Replace hex values in inline styles
    const styleFillRegex = new RegExp(`(fill:\\s*)#?${escapedHex}`, 'gi');
    result = result.replace(styleFillRegex, `$1${tokenName}`);

    const styleStrokeRegex = new RegExp(`(stroke:\\s*)#?${escapedHex}`, 'gi');
    result = result.replace(styleStrokeRegex, `$1${tokenName}`);

    const styleStopColorRegex = new RegExp(`(stop-color:\\s*)#?${escapedHex}`, 'gi');
    result = result.replace(styleStopColorRegex, `$1${tokenName}`);

    // Also replace CSS color keyword if applicable
    if (colorName) {
      const fillNameRegex = new RegExp(`(fill=["'])${colorName}(["'])`, 'gi');
      result = result.replace(fillNameRegex, `$1${tokenName}$2`);

      const strokeNameRegex = new RegExp(`(stroke=["'])${colorName}(["'])`, 'gi');
      result = result.replace(strokeNameRegex, `$1${tokenName}$2`);

      const stopColorNameRegex = new RegExp(`(stop-color=["'])${colorName}(["'])`, 'gi');
      result = result.replace(stopColorNameRegex, `$1${tokenName}$2`);

      const styleFillNameRegex = new RegExp(`(fill:\\s*)${colorName}(?![a-z])`, 'gi');
      result = result.replace(styleFillNameRegex, `$1${tokenName}`);

      const styleStrokeNameRegex = new RegExp(`(stroke:\\s*)${colorName}(?![a-z])`, 'gi');
      result = result.replace(styleStrokeNameRegex, `$1${tokenName}`);

      const styleStopColorNameRegex = new RegExp(`(stop-color:\\s*)${colorName}(?![a-z])`, 'gi');
      result = result.replace(styleStopColorNameRegex, `$1${tokenName}`);
    }
  }

  return result;
}

function replaceSvgHexWithTokenNamesAndHex(svgString, hexToTokenHexMap) {
  let result = svgString;

  for (const hex in hexToTokenHexMap) {
    const { tokenName, fallback } = hexToTokenHexMap[hex];
    const escapedHex = hex.replace('#', '');
    const colorName = HEX_TO_COLOR_NAME[escapedHex.toUpperCase()];
    const replacement = `var(--${tokenName}, ${fallback})`;

    // Replace hex values with var(--token name, hex) in fill/stroke attributes
    const fillAttrRegex = new RegExp(`(fill=["'])#?${escapedHex}(["'])`, 'gi');
    result = result.replace(fillAttrRegex, `$1${replacement}$2`);

    const strokeAttrRegex = new RegExp(`(stroke=["'])#?${escapedHex}(["'])`, 'gi');
    result = result.replace(strokeAttrRegex, `$1${replacement}$2`);

    // Replace hex values in gradient stop-color attributes
    const stopColorAttrRegex = new RegExp(`(stop-color=["'])#?${escapedHex}(["'])`, 'gi');
    result = result.replace(stopColorAttrRegex, `$1${replacement}$2`);

    // Replace hex values in inline styles
    const styleFillRegex = new RegExp(`(fill:\\s*)#?${escapedHex}`, 'gi');
    result = result.replace(styleFillRegex, `$1${replacement}`);

    const styleStrokeRegex = new RegExp(`(stroke:\\s*)#?${escapedHex}`, 'gi');
    result = result.replace(styleStrokeRegex, `$1${replacement}`);

    const styleStopColorRegex = new RegExp(`(stop-color:\\s*)#?${escapedHex}`, 'gi');
    result = result.replace(styleStopColorRegex, `$1${replacement}`);

    // Also replace CSS color keyword if applicable
    if (colorName) {
      const fillNameRegex = new RegExp(`(fill=["'])${colorName}(["'])`, 'gi');
      result = result.replace(fillNameRegex, `$1${replacement}$2`);

      const strokeNameRegex = new RegExp(`(stroke=["'])${colorName}(["'])`, 'gi');
      result = result.replace(strokeNameRegex, `$1${replacement}$2`);

      const stopColorNameRegex = new RegExp(`(stop-color=["'])${colorName}(["'])`, 'gi');
      result = result.replace(stopColorNameRegex, `$1${replacement}$2`);

      const styleFillNameRegex = new RegExp(`(fill:\\s*)${colorName}(?![a-z])`, 'gi');
      result = result.replace(styleFillNameRegex, `$1${replacement}`);

      const styleStrokeNameRegex = new RegExp(`(stroke:\\s*)${colorName}(?![a-z])`, 'gi');
      result = result.replace(styleStrokeNameRegex, `$1${replacement}`);

      const styleStopColorNameRegex = new RegExp(`(stop-color:\\s*)${colorName}(?![a-z])`, 'gi');
      result = result.replace(styleStopColorNameRegex, `$1${replacement}`);
    }
  }

  return result;
}

// Collect all bound variable IDs from a node tree (for collection detection)
// `modeColIds` (optional) collects every collection this subtree resolves against.
// That's the only way to discover extension collections owned by another library:
// VariableCollection only points upward via parentVariableCollectionId, so a parent
// can't be asked for its children, and scanning local collections misses remote ones.
async function collectBoundVariableIds(node, varIds, modeColIds) {
  if (modeColIds && 'resolvedVariableModes' in node && node.resolvedVariableModes) {
    for (const colId in node.resolvedVariableModes) modeColIds.add(colId);
  }

  // Helper to process paint arrays
  function processPaints(paints) {
    if (!paints || !Array.isArray(paints)) return;
    for (const paint of paints) {
      if (paint.type === 'SOLID' && paint.boundVariables?.color?.id) {
        varIds.add(paint.boundVariables.color.id);
      }
      // Also check gradient stops
      if ((paint.type === 'GRADIENT_LINEAR' || paint.type === 'GRADIENT_RADIAL' || paint.type === 'GRADIENT_ANGULAR' || paint.type === 'GRADIENT_DIAMOND') && paint.gradientStops) {
        for (const stop of paint.gradientStops) {
          if (stop.boundVariables?.color?.id) {
            varIds.add(stop.boundVariables.color.id);
          }
        }
      }
    }
  }

  if ('fills' in node && Array.isArray(node.fills)) {
    processPaints(node.fills);
  } else if ('fills' in node && typeof node.fills === 'symbol') {
    // Mixed fills (VECTOR with multiple colored paths) - check vectorNetwork.regions
    if ('vectorNetwork' in node && node.vectorNetwork && node.vectorNetwork.regions) {
      for (const region of node.vectorNetwork.regions) {
        processPaints(region.fills);
      }
    }
  }

  if ('strokes' in node && Array.isArray(node.strokes)) {
    processPaints(node.strokes);
  }

  if ('children' in node) {
    for (const child of node.children) {
      await collectBoundVariableIds(child, varIds, modeColIds);
    }
  }
}

// variableOverrides is a native getter — every read re-marshals the entire structure
// across the sandbox boundary (Riyad alone carries 209 entries). resolveColorForMode is
// called per token per mode per collection, so reading it directly is the pattern that
// caused the "Plugin runtime aborted" OOM; see the note in loadVariables(). Snapshot the
// object once per collection and only read the snapshot.
let overridesSnapshotCache = {};
function getCollectionOverrides(col) {
  if (!Object.prototype.hasOwnProperty.call(overridesSnapshotCache, col.id)) {
    overridesSnapshotCache[col.id] = col.variableOverrides || {};
  }
  return overridesSnapshotCache[col.id];
}

// Values can change between runs, so start each export from a clean snapshot
function resetOverridesSnapshot() {
  overridesSnapshotCache = {};
}

// Resolve a color variable's value for a specific collection+mode
// Now fetches library data as needed
async function resolveColorForMode(varId, targetColId, targetModeId, colCache, varCache) {
  // Fetch variable if not in cache
  let variable = varCache[varId];
  if (!variable) {
    try {
      const v = await figma.variables.getVariableByIdAsync(varId);
      if (v) {
        variable = v;
        varCache[varId] = v;
      }
    } catch (e) {}
  }
  if (!variable || variable.resolvedType !== 'COLOR') return null;

  // Fetch target collection if not in cache
  let targetCol = colCache[targetColId];
  if (!targetCol) {
    try {
      const c = await figma.variables.getVariableCollectionByIdAsync(targetColId);
      if (c) {
        targetCol = c;
        colCache[targetColId] = c;
      }
    } catch (e) {}
  }
  if (!targetCol) return null;

  // For extended collections, we need to check overrides first, then walk up parent chain
  let value = null;

  if (targetCol.isExtension) {
    const overrides = getCollectionOverrides(targetCol);
    const override = overrides[varId];
    if (override && override[targetModeId] !== undefined) {
      value = override[targetModeId];
    }
  }

  // If variable is in a different collection than target, find matching mode by name
  if (!value && variable.variableCollectionId !== targetColId) {
    const targetModeObj = targetCol.modes.find(m => m.modeId === targetModeId);
    if (targetModeObj) {
      // Get the variable's own collection
      let varCol = colCache[variable.variableCollectionId];
      if (!varCol) {
        try {
          const c = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId);
          if (c) {
            varCol = c;
            colCache[variable.variableCollectionId] = c;
          }
        } catch (e) {}
      }
      if (varCol) {
        // Find matching mode by name or index
        const varModeByName = varCol.modes.find(m => m.name === targetModeObj.name);
        const targetModeIdx = targetCol.modes.findIndex(m => m.modeId === targetModeId);
        const varModeByIdx = varCol.modes[targetModeIdx];
        const varMode = varModeByName || varModeByIdx || varCol.modes[0];
        if (varMode && variable.valuesByMode) {
          value = variable.valuesByMode[varMode.modeId];
        }
      }
    }
  }

  // If no override and same collection, use the variable's own valuesByMode
  if (!value && variable.valuesByMode) {
    value = variable.valuesByMode[targetModeId];
  }

  // If still no value and this is an extension, try parent mode mapping
  if (!value && targetCol.isExtension && targetCol.parentVariableCollectionId) {
    let parentCol = colCache[targetCol.parentVariableCollectionId];
    if (!parentCol) {
      try {
        const c = await figma.variables.getVariableCollectionByIdAsync(targetCol.parentVariableCollectionId);
        if (c) {
          parentCol = c;
          colCache[targetCol.parentVariableCollectionId] = c;
        }
      } catch (e) {}
    }
    if (parentCol) {
      // Find corresponding parent mode (by index or name)
      const modeIdx = targetCol.modes.findIndex(m => m.modeId === targetModeId);
      const parentMode = parentCol.modes[modeIdx] || parentCol.modes[0];
      if (parentMode && variable.valuesByMode) {
        value = variable.valuesByMode[parentMode.modeId];
      }
    }
  }

  // Resolve alias if needed (up to 10 hops)
  let depth = 0;
  while (value && value.type === 'VARIABLE_ALIAS' && depth < 10) {
    let aliasVar = varCache[value.id];
    if (!aliasVar) {
      try {
        const v = await figma.variables.getVariableByIdAsync(value.id);
        if (v) {
          aliasVar = v;
          varCache[value.id] = v;
        }
      } catch (e) {}
    }
    if (!aliasVar || aliasVar.resolvedType !== 'COLOR') break;

    // Get the alias's collection to find matching mode
    let aliasCol = colCache[aliasVar.variableCollectionId];
    if (!aliasCol) {
      try {
        const c = await figma.variables.getVariableCollectionByIdAsync(aliasVar.variableCollectionId);
        if (c) {
          aliasCol = c;
          colCache[aliasVar.variableCollectionId] = c;
        }
      } catch (e) {}
    }

    if (aliasCol && aliasVar.valuesByMode) {
      // Find matching mode by name or index
      const targetModeObj = targetCol.modes.find(m => m.modeId === targetModeId);
      const aliasModeByName = aliasCol.modes.find(m => m.name === (targetModeObj ? targetModeObj.name : ''));
      const targetModeIdx = targetCol.modes.findIndex(m => m.modeId === targetModeId);
      const aliasModeByIdx = aliasCol.modes[targetModeIdx];
      const aliasMode = aliasModeByName || aliasModeByIdx || aliasCol.modes[0];

      if (aliasMode) {
        value = aliasVar.valuesByMode[aliasMode.modeId];
      } else {
        break;
      }
    } else {
      break;
    }
    depth++;
  }

  // Return the color object if it's a valid color
  if (value && typeof value === 'object' && 'r' in value) {
    return value;
  }

  return null;
}

// Replace hex colors in SVG with mode-resolved colors
function replaceSvgHexWithResolved(svgString, hexToResolvedMap) {
  const keys = Object.keys(hexToResolvedMap);
  if (keys.length === 0) return svgString;

  let result = svgString;
  const placeholders = [];

  // Two tokens can legitimately swap values between modes (e.g. Surface/OnSurface
  // flipping light<->dark), so one entry's target hex can equal another entry's source
  // hex. Writing final hex values directly in one pass over the same buffer means a
  // later entry's search can re-match text an earlier entry JUST wrote, silently
  // merging both onto whichever value was written last. Route every source hex/color
  // name through a placeholder first — placeholders can't collide with real hex or
  // color-keyword text, so no entry can ever re-match another's output.
  keys.forEach((hex, i) => {
    const newHex = hexToResolvedMap[hex];
    const escapedHex = hex.replace('#', '');
    const newHexVal = newHex.replace('#', '');
    const colorName = HEX_TO_COLOR_NAME[escapedHex.toUpperCase()];
    const placeholder = `@@TM_HEX_${i}@@`;
    placeholders.push({ placeholder, newHexVal });

    // Replace hex values in fill/stroke attributes
    const fillAttrRegex = new RegExp(`(fill=["'])#?${escapedHex}(["'])`, 'gi');
    result = result.replace(fillAttrRegex, `$1${placeholder}$2`);

    const strokeAttrRegex = new RegExp(`(stroke=["'])#?${escapedHex}(["'])`, 'gi');
    result = result.replace(strokeAttrRegex, `$1${placeholder}$2`);

    // Replace hex values in gradient stop-color attributes
    const stopColorAttrRegex = new RegExp(`(stop-color=["'])#?${escapedHex}(["'])`, 'gi');
    result = result.replace(stopColorAttrRegex, `$1${placeholder}$2`);

    // Replace hex values in inline styles
    const styleFillRegex = new RegExp(`(fill:\\s*)#?${escapedHex}`, 'gi');
    result = result.replace(styleFillRegex, `$1${placeholder}`);

    const styleStrokeRegex = new RegExp(`(stroke:\\s*)#?${escapedHex}`, 'gi');
    result = result.replace(styleStrokeRegex, `$1${placeholder}`);

    const styleStopColorRegex = new RegExp(`(stop-color:\\s*)#?${escapedHex}`, 'gi');
    result = result.replace(styleStopColorRegex, `$1${placeholder}`);

    // Also replace CSS color keyword if applicable (Figma exports #000000 as "black", #FFFFFF as "white", etc.)
    if (colorName) {
      const fillNameRegex = new RegExp(`(fill=["'])${colorName}(["'])`, 'gi');
      result = result.replace(fillNameRegex, `$1${placeholder}$2`);

      const strokeNameRegex = new RegExp(`(stroke=["'])${colorName}(["'])`, 'gi');
      result = result.replace(strokeNameRegex, `$1${placeholder}$2`);

      const stopColorNameRegex = new RegExp(`(stop-color=["'])${colorName}(["'])`, 'gi');
      result = result.replace(stopColorNameRegex, `$1${placeholder}$2`);

      const styleFillNameRegex = new RegExp(`(fill:\\s*)${colorName}(?![a-z])`, 'gi');
      result = result.replace(styleFillNameRegex, `$1${placeholder}`);

      const styleStrokeNameRegex = new RegExp(`(stroke:\\s*)${colorName}(?![a-z])`, 'gi');
      result = result.replace(styleStrokeNameRegex, `$1${placeholder}`);

      const styleStopColorNameRegex = new RegExp(`(stop-color:\\s*)${colorName}(?![a-z])`, 'gi');
      result = result.replace(styleStopColorNameRegex, `$1${placeholder}`);
    }
  });

  // Every occurrence is now a placeholder, not real hex/color text, so swapping in the
  // final values can't cascade regardless of overlap between sources and targets.
  placeholders.forEach(({ placeholder, newHexVal }) => {
    result = result.split(placeholder).join(`#${newHexVal}`);
  });

  return result;
}
// last modified by AI tools on 2026-11-02

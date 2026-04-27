figma.showUI(__html__, { width: 800, height: 600 });

// 1. Refactor logic into a reusable function
async function loadVariables() {
  try {
    const collections = figma.variables.getLocalVariableCollections();

    const localVariables = figma.variables.getLocalVariables();
    const fileName = figma.root.name;

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

    // Prep data for UI
    const dataForUi = await Promise.all(collections.map(async (collection) => {
      const processedVars = await Promise.all(collection.variableIds.map(async (varId) => {
        try {
          const v = localVariables.find(variable => variable.id === varId);
          if (!v) return null;

          // Helper function to resolve color values
          const resolveColorForMode = async (modeIdx) => {
            if (v.resolvedType !== 'COLOR' || !collection.modes[modeIdx]) return null;
            
            let currentVal = v.valuesByMode[collection.modes[modeIdx].modeId];
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
              let currentVal = v.valuesByMode[mId];
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
            valuesByMode: v.valuesByMode,
            scopes: v.scopes,
            resolvedValuesByMode: resolvedValues, 
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
    figma.ui.postMessage({ type: 'load-theme', theme: theme || 'dark' });
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
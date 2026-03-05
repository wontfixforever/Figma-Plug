function getExpandedSelection(nodes) {
  const result = [];

  function addNodeOrChildren(node) {
    if (node.type === "GROUP" || node.type === "FRAME") {
      if ("children" in node) {
        node.children.forEach(addNodeOrChildren);
      }
    } else {
      result.push(node);
    }
  }

  nodes.forEach(addNodeOrChildren);
  return result;
}

figma.showUI(__html__, { width: 380, height: 100 });

let currentSort = 'az';

async function sendLayerDataToUI(selection) {
  const data = await Promise.all(
    selection.map(async (node) => {
      let thumbnail;

      if (node.type === "TEXT") {
        thumbnail = "__t-placeholder__";
      } else if (node.type === "COMPONENT_SET") {
        thumbnail = "__c-placeholder__";
      } else {
        try {
          const bytes = await node.exportAsync({
            format: "PNG",
            constraint: { type: "SCALE", value: 2 },
          });
          const base64 = figma.base64Encode(bytes);
          thumbnail = `data:image/png;base64,${base64}`;
        } catch (err) {
          thumbnail = "";
        }
      }

      return {
        name: node.name,
        type: node.type,
        thumbnail,
      };
    })
  );

  figma.ui.postMessage({ type: "layer-data", payload: sortData(data, currentSort) });
}

function sortData(data, mode) {
  
  if (mode === 'az') {
    return [...data].sort((a, b) => 
      a.name.toLowerCase().localeCompare(b.name.toLowerCase())
    );
    
    } else if (mode === 'type') {
      return [...data].sort((a, b) => a.type.localeCompare(b.type, undefined, { sensitivity: 'base' }));
    } 
      else if (mode === 'layer') {
      return [...data].reverse(); // reverse original stacking order
    }
    return data;
  }

figma.ui.onmessage = (msg) => {
  if (msg.type === "ui-ready") {
    sendLayerDataToUI(getExpandedSelection(figma.currentPage.selection));
  } else if (msg.type === "resize" && typeof msg.height === "number") {
    figma.ui.resize(380, Math.max(100, Math.min(600, msg.height)));
  } else if (msg.type === "close") {
    figma.closePlugin();
  } else if (msg.type === "sort-change") {
    currentSort = msg.value;
    sendLayerDataToUI(getExpandedSelection(figma.currentPage.selection));
  }
};

figma.on("selectionchange", () => {
  sendLayerDataToUI(getExpandedSelection(figma.currentPage.selection));
});

sendLayerDataToUI(getExpandedSelection(figma.currentPage.selection));

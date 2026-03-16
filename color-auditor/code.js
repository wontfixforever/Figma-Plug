figma.showUI(__html__, { width: 380, height: 620 });

// ── helpers ──────────────────────────────────────────────────────────────────

function rgbToHex(r, g, b) {
  var h = function(v) { return Math.round(v * 255).toString(16).padStart(2, '0'); };
  return ('#' + h(r) + h(g) + h(b)).toUpperCase();
}

function getBoundVariableId(paint) {
  if (paint.boundVariables && paint.boundVariables.color && paint.boundVariables.color.id) {
    return paint.boundVariables.color.id;
  }
  return null;
}

function safeFills(node) {
  if (!('fills' in node) || node.fills === figma.mixed) return [];
  var fills = node.fills || [];
  return fills
    .filter(function(p) { return p.type === 'SOLID'; })
    .map(function(p) {
      return {
        hex: rgbToHex(p.color.r, p.color.g, p.color.b),
        opacity: (p.opacity !== undefined ? p.opacity : 1),
        visible: p.visible !== false,
        boundVariableId: getBoundVariableId(p)
      };
    });
}

function safeStrokes(node) {
  if (!('strokes' in node) || node.strokes === figma.mixed) return [];
  var strokes = node.strokes || [];
  return strokes
    .filter(function(p) { return p.type === 'SOLID'; })
    .map(function(p) {
      return {
        hex: rgbToHex(p.color.r, p.color.g, p.color.b),
        opacity: (p.opacity !== undefined ? p.opacity : 1),
        visible: p.visible !== false,
        boundVariableId: getBoundVariableId(p)
      };
    });
}

function buildParentChain(node) {
  var chain = [];
  var current = node;
  while (current && current.type !== 'PAGE' && current.type !== 'DOCUMENT') {
    chain.push({
      nodeId: current.id,
      nodeName: current.name,
      nodeType: current.type,
      fills: safeFills(current)
    });
    current = current.parent;
  }
  return chain;
}

function collectNodes(root, results) {
  function visit(node) {
    var fills = safeFills(node);
    var strokes = safeStrokes(node);
    if (fills.length > 0 || strokes.length > 0) {
      var bounds = null;
      try { bounds = node.absoluteBoundingBox; } catch (e) {}
      results.push({
        nodeId: node.id,
        nodeName: node.name,
        nodeType: node.type,
        fills: fills,
        strokes: strokes,
        parentChain: node.parent ? buildParentChain(node.parent) : [],
        canvasX: bounds ? bounds.x : null,
        canvasY: bounds ? bounds.y : null
      });
    }
    if ('children' in node) {
      for (var i = 0; i < node.children.length; i++) {
        visit(node.children[i]);
      }
    }
  }
  visit(root);
}

// ── message handler ───────────────────────────────────────────────────────────

figma.ui.onmessage = async function(msg) {
  switch (msg.type) {

    case 'ui-ready': {
      var patRaw = await figma.clientStorage.getAsync('gh_pat');
      var pat = (patRaw !== undefined ? patRaw : null);
      var figmaPatRaw = await figma.clientStorage.getAsync('figma_pat');
      var figmaPat = (figmaPatRaw !== undefined ? figmaPatRaw : null);
      var settingsRaw = await figma.clientStorage.getAsync('audit_settings');
      var settings = (settingsRaw !== undefined ? settingsRaw : {});
      figma.ui.postMessage({
        type: 'init',
        pat: pat,
        figmaPat: figmaPat,
        settings: settings,
        fileName: figma.root.name,
        fileKey: figma.fileKey || null
      });
      break;
    }

    case 'save-pat': {
      await figma.clientStorage.setAsync('gh_pat', msg.pat || null);
      figma.ui.postMessage({ type: 'pat-saved' });
      break;
    }

    case 'save-figma-pat': {
      await figma.clientStorage.setAsync('figma_pat', msg.pat || null);
      break;
    }

    case 'save-settings': {
      await figma.clientStorage.setAsync('audit_settings', msg.settings);
      break;
    }

    case 'run-audit': {
      var roots = (msg.scope === 'selection' && figma.currentPage.selection.length > 0)
        ? figma.currentPage.selection
        : [figma.currentPage];

      var allNodes = [];
      for (var ri = 0; ri < roots.length; ri++) {
        collectNodes(roots[ri], allNodes);
      }

      // Collect all unique bound variable IDs from nodes + their parent chains
      var varIdSet = {};
      for (var ni = 0; ni < allNodes.length; ni++) {
        var n = allNodes[ni];
        var allPaints = n.fills.concat(n.strokes);
        for (var pi = 0; pi < allPaints.length; pi++) {
          if (allPaints[pi].boundVariableId) varIdSet[allPaints[pi].boundVariableId] = true;
        }
        for (var ai = 0; ai < n.parentChain.length; ai++) {
          var ancestor = n.parentChain[ai];
          for (var fi = 0; fi < ancestor.fills.length; fi++) {
            if (ancestor.fills[fi].boundVariableId) varIdSet[ancestor.fills[fi].boundVariableId] = true;
          }
        }
      }
      var varIds = Object.keys(varIdSet);

      // Batch-resolve variable IDs → token names
      var varMap = {};
      await Promise.all(varIds.map(async function(id) {
        try {
          var v = await figma.variables.getVariableByIdAsync(id);
          if (v) varMap[id] = v.name;
        } catch (e) {
          // external variable not accessible — treat as unresolved
        }
      }));

      figma.ui.postMessage({ type: 'audit-data', nodes: allNodes, varMap: varMap, nodeCount: allNodes.length });
      break;
    }

    // Store comment IDs in page plugin data so they survive session restarts
    case 'store-comment-ids': {
      var ids = msg.ids || [];
      figma.currentPage.setPluginData('ratio_audit_comment_ids', JSON.stringify(ids));
      break;
    }

    // Return stored comment IDs to the UI for deletion
    case 'get-comment-ids': {
      var raw = figma.currentPage.getPluginData('ratio_audit_comment_ids');
      var ids = [];
      try { ids = raw ? JSON.parse(raw) : []; } catch (e) {}
      figma.ui.postMessage({ type: 'comment-ids', ids: ids });
      break;
    }

    case 'focus-node': {
      var node = figma.getNodeById(msg.nodeId);
      if (node) {
        figma.currentPage.selection = [node];
        figma.viewport.scrollAndZoomIntoView([node]);
      }
      break;
    }

    case 'resize': {
      figma.ui.resize(msg.width, msg.height);
      break;
    }
  }
};

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
      results.push({
        nodeId: node.id,
        nodeName: node.name,
        nodeType: node.type,
        fills: fills,
        strokes: strokes,
        parentChain: node.parent ? buildParentChain(node.parent) : []
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

// ── comment writer ────────────────────────────────────────────────────────────
// Stores Comment objects for the current session so they can be removed.
// Comments from previous sessions must be cleared manually from Figma's
// comment panel (there is no plugin API to list/retrieve comments by ID).
var sessionComments = [];

function buildCommentText(finding) {
  var prefix = '[RATIO Audit] ';
  if (finding.type === 'HARDCODED') {
    var candidates = (finding.candidates || []).slice(0, 3).join(', ');
    var extra = finding.candidates && finding.candidates.length > 3
      ? ' (+' + (finding.candidates.length - 3) + ' more)'
      : '';
    return prefix + 'Hardcoded ' + finding.hex + '\nSuggested token: ' + candidates + extra;
  }
  if (finding.type === 'DRIFT') {
    return prefix + 'Drift: ' + finding.hex + ' \u2248 ' + finding.closestToken
      + ' (' + finding.closestHex + ')\n\u0394E=' + finding.deltaE + ' \u00b7 ' + finding.confidence + ' confidence';
  }
  return prefix + 'Semantic misuse\n' + (finding.suggestion || '');
}

function writeComments(findings) {
  // Remove any comments left from this session
  for (var i = 0; i < sessionComments.length; i++) {
    try { sessionComments[i].remove(); } catch (e) {}
  }
  sessionComments = [];

  var added = 0;
  for (var j = 0; j < findings.length; j++) {
    var finding = findings[j];
    var targetNode = figma.getNodeById(finding.nodeId);
    if (!targetNode) continue;

    var bounds;
    try { bounds = targetNode.absoluteBoundingBox; } catch (e) { continue; }
    if (!bounds) continue;

    var text = buildCommentText(finding);
    try {
      var comment = figma.createComment(text, { x: bounds.x - 20, y: bounds.y - 20 });
      sessionComments.push(comment);
      added++;
    } catch (e) {
      figma.notify('figma.createComment not available — update Figma to the latest version', { timeout: 4000 });
      break;
    }
  }

  if (added > 0) {
    figma.notify(added + ' comment' + (added !== 1 ? 's' : '') + ' added');
  }
}

function clearComments() {
  var count = 0;
  for (var i = 0; i < sessionComments.length; i++) {
    try { sessionComments[i].remove(); count++; } catch (e) {}
  }
  sessionComments = [];
  if (count > 0) {
    figma.notify('Audit comments cleared');
  } else {
    figma.notify('No comments from this session — clear previous-run comments from the Figma comments panel', { timeout: 4000 });
  }
}

// ── message handler ───────────────────────────────────────────────────────────

figma.ui.onmessage = async function(msg) {
  switch (msg.type) {

    case 'ui-ready': {
      var patRaw = await figma.clientStorage.getAsync('gh_pat');
      var pat = (patRaw !== undefined ? patRaw : null);
      var settingsRaw = await figma.clientStorage.getAsync('audit_settings');
      var settings = (settingsRaw !== undefined ? settingsRaw : {});
      figma.ui.postMessage({ type: 'init', pat: pat, settings: settings, fileName: figma.root.name });
      break;
    }

    case 'save-pat': {
      await figma.clientStorage.setAsync('gh_pat', msg.pat || null);
      figma.ui.postMessage({ type: 'pat-saved' });
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

    case 'write-annotations': {
      writeComments(msg.findings);
      break;
    }

    case 'clear-annotations': {
      clearComments();
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

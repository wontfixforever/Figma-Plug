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

// ── annotation writer ─────────────────────────────────────────────────────────

var AUDIT_FRAME_NAME = '🔍 RATIO Color Audit';

async function clearAnnotations() {
  var existing = figma.currentPage.children.filter(function(n) { return n.name === AUDIT_FRAME_NAME; });
  for (var i = 0; i < existing.length; i++) {
    existing[i].remove();
  }
}

async function writeAnnotations(findings) {
  await clearAnnotations();
  if (findings.length === 0) return;

  var fontsLoaded = false;
  try {
    await Promise.all([
      figma.loadFontAsync({ family: 'Inter', style: 'Medium' }),
      figma.loadFontAsync({ family: 'Inter', style: 'Regular' })
    ]);
    fontsLoaded = true;
  } catch (e) {
    figma.notify('Could not load Inter font — annotations will be label-only', { timeout: 3000 });
  }

  var auditGroup = figma.createFrame();
  auditGroup.name = AUDIT_FRAME_NAME;
  auditGroup.fills = [];
  auditGroup.clipsContent = false;
  auditGroup.resize(1, 1);

  var COLORS = {
    HARDCODED: { r: 0.88, g: 0.18, b: 0.18 },
    DRIFT:     { r: 0.91, g: 0.45, b: 0.00 },
    MISMATCH:  { r: 0.75, g: 0.55, b: 0.00 }
  };

  var TEXT_WHITE = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
  var TEXT_DIM   = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 0.8 } }];

  for (var i = 0; i < findings.length; i++) {
    var finding = findings[i];
    var targetNode = figma.getNodeById(finding.nodeId);
    if (!targetNode) continue;

    var bounds;
    try {
      bounds = targetNode.absoluteBoundingBox;
    } catch (e) {
      continue;
    }
    if (!bounds) continue;

    var typeKey = finding.type;
    var badgeColor = COLORS[typeKey] || COLORS.HARDCODED;

    var badge = figma.createFrame();
    badge.resize(220, fontsLoaded ? 52 : 20);
    badge.cornerRadius = 4;
    badge.fills = [{ type: 'SOLID', color: badgeColor }];

    if (fontsLoaded) {
      var typeLabel = figma.createText();
      typeLabel.fontName = { family: 'Inter', style: 'Medium' };
      typeLabel.fontSize = 10;
      typeLabel.lineHeight = { unit: 'PIXELS', value: 14 };
      typeLabel.fills = TEXT_WHITE;
      typeLabel.characters = typeKey === 'HARDCODED' ? '⚑ HARDCODED'
                           : typeKey === 'DRIFT'     ? '≈ DRIFT'
                           : '⚠ SEMANTIC MISUSE';
      typeLabel.x = 8;
      typeLabel.y = 6;
      badge.appendChild(typeLabel);

      var detail = figma.createText();
      detail.fontName = { family: 'Inter', style: 'Regular' };
      detail.fontSize = 9;
      detail.lineHeight = { unit: 'PIXELS', value: 13 };
      detail.resize(204, 26);
      detail.textAutoResize = 'HEIGHT';
      detail.fills = TEXT_DIM;
      detail.characters = (finding.suggestion || '').slice(0, 50);
      detail.x = 8;
      detail.y = 24;
      badge.appendChild(detail);
    }

    var suggestionText = finding.suggestion || finding.hex || '';
    badge.name = ('[RATIO] ' + typeKey + ': ' + suggestionText).slice(0, 80);
    badge.x = bounds.x + bounds.width + 8;
    badge.y = bounds.y;
    auditGroup.appendChild(badge);
  }

  if (auditGroup.children.length === 0) {
    auditGroup.remove();
    return;
  }

  var children = auditGroup.children;
  var xs      = children.map(function(c) { return c.x; });
  var ys      = children.map(function(c) { return c.y; });
  var rights  = children.map(function(c) { return c.x + c.width; });
  var bottoms = children.map(function(c) { return c.y + c.height; });
  var minX = Math.min.apply(null, xs);
  var minY = Math.min.apply(null, ys);

  auditGroup.x = minX;
  auditGroup.y = minY;
  auditGroup.resize(Math.max.apply(null, rights) - minX, Math.max.apply(null, bottoms) - minY);

  figma.currentPage.appendChild(auditGroup);
  var count = auditGroup.children.length;
  figma.notify(count + ' annotation' + (count === 1 ? '' : 's') + ' added to canvas');
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
      await writeAnnotations(msg.findings);
      break;
    }

    case 'clear-annotations': {
      await clearAnnotations();
      figma.notify('Audit comments cleared');
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

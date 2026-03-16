figma.showUI(__html__, { width: 380, height: 620 });

// ── helpers ──────────────────────────────────────────────────────────────────

function rgbToHex(r, g, b) {
  const h = v => Math.round(v * 255).toString(16).padStart(2, '0');
  return ('#' + h(r) + h(g) + h(b)).toUpperCase();
}

function safeFills(node) {
  if (!('fills' in node) || node.fills === figma.mixed) return [];
  return (node.fills || [])
    .filter(p => p.type === 'SOLID')
    .map(p => ({
      hex: rgbToHex(p.color.r, p.color.g, p.color.b),
      opacity: p.opacity ?? 1,
      visible: p.visible !== false,
      boundVariableId: p.boundVariables?.color?.id ?? null
    }));
}

function safeStrokes(node) {
  if (!('strokes' in node) || node.strokes === figma.mixed) return [];
  return (node.strokes || [])
    .filter(p => p.type === 'SOLID')
    .map(p => ({
      hex: rgbToHex(p.color.r, p.color.g, p.color.b),
      opacity: p.opacity ?? 1,
      visible: p.visible !== false,
      boundVariableId: p.boundVariables?.color?.id ?? null
    }));
}

function buildParentChain(node) {
  const chain = [];
  let current = node;
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
    const fills = safeFills(node);
    const strokes = safeStrokes(node);
    if (fills.length > 0 || strokes.length > 0) {
      results.push({
        nodeId: node.id,
        nodeName: node.name,
        nodeType: node.type,
        fills,
        strokes,
        parentChain: node.parent ? buildParentChain(node.parent) : []
      });
    }
    if ('children' in node) {
      for (const child of node.children) visit(child);
    }
  }
  visit(root);
}

// ── annotation writer ─────────────────────────────────────────────────────────

const AUDIT_FRAME_NAME = '🔍 RATIO Color Audit';

async function clearAnnotations() {
  const existing = figma.currentPage.children.filter(n => n.name === AUDIT_FRAME_NAME);
  for (const f of existing) f.remove();
}

async function writeAnnotations(findings) {
  await clearAnnotations();
  if (findings.length === 0) return;

  let fontsLoaded = false;
  try {
    await Promise.all([
      figma.loadFontAsync({ family: 'Inter', style: 'Medium' }),
      figma.loadFontAsync({ family: 'Inter', style: 'Regular' })
    ]);
    fontsLoaded = true;
  } catch {
    figma.notify('Could not load Inter font — annotations will be label-only', { timeout: 3000 });
  }

  const auditGroup = figma.createFrame();
  auditGroup.name = AUDIT_FRAME_NAME;
  auditGroup.fills = [];
  auditGroup.clipsContent = false;
  auditGroup.resize(1, 1);

  const COLORS = {
    HARDCODED: { r: 0.88, g: 0.18, b: 0.18 },
    DRIFT:     { r: 0.91, g: 0.45, b: 0.00 },
    MISMATCH:  { r: 0.75, g: 0.55, b: 0.00 }
  };

  const TEXT_WHITE = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
  const TEXT_DIM   = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 0.8 } }];

  for (const finding of findings) {
    const targetNode = figma.getNodeById(finding.nodeId);
    if (!targetNode) continue;
    let bounds;
    try { bounds = targetNode.absoluteBoundingBox; } catch { continue; }
    if (!bounds) continue;

    const typeKey = finding.type;
    const badge = figma.createFrame();
    badge.resize(220, fontsLoaded ? 52 : 20);
    badge.cornerRadius = 4;
    badge.fills = [{ type: 'SOLID', color: COLORS[typeKey] ?? COLORS.HARDCODED }];

    if (fontsLoaded) {
      const typeLabel = figma.createText();
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

      const detail = figma.createText();
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

    // Name includes full description for layers panel visibility
    badge.name = `[RATIO] ${typeKey}: ${finding.suggestion || finding.hex || ''}`.slice(0, 80);
    badge.x = bounds.x + bounds.width + 8;
    badge.y = bounds.y;
    auditGroup.appendChild(badge);
  }

  if (auditGroup.children.length === 0) {
    auditGroup.remove();
    return;
  }

  // Reposition the audit group to enclose all badges
  const xs = auditGroup.children.map(c => c.x);
  const ys = auditGroup.children.map(c => c.y);
  const rights  = auditGroup.children.map(c => c.x + c.width);
  const bottoms = auditGroup.children.map(c => c.y + c.height);
  const minX = Math.min(...xs), minY = Math.min(...ys);

  auditGroup.x = minX;
  auditGroup.y = minY;
  auditGroup.resize(Math.max(...rights) - minX, Math.max(...bottoms) - minY);

  figma.currentPage.appendChild(auditGroup);
  figma.notify(`${auditGroup.children.length} annotation${auditGroup.children.length === 1 ? '' : 's'} added to canvas`);
}

// ── message handler ───────────────────────────────────────────────────────────

figma.ui.onmessage = async (msg) => {
  switch (msg.type) {

    case 'ui-ready': {
      const pat = await figma.clientStorage.getAsync('gh_pat') ?? null;
      const settings = await figma.clientStorage.getAsync('audit_settings') ?? {};
      figma.ui.postMessage({ type: 'init', pat, settings, fileName: figma.root.name });
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
      const roots = (msg.scope === 'selection' && figma.currentPage.selection.length > 0)
        ? figma.currentPage.selection
        : [figma.currentPage];

      const allNodes = [];
      for (const root of roots) collectNodes(root, allNodes);

      // Collect all unique bound variable IDs from nodes + their parent chains
      const varIds = new Set();
      for (const n of allNodes) {
        for (const f of [...n.fills, ...n.strokes]) {
          if (f.boundVariableId) varIds.add(f.boundVariableId);
        }
        for (const ancestor of n.parentChain) {
          for (const f of ancestor.fills) {
            if (f.boundVariableId) varIds.add(f.boundVariableId);
          }
        }
      }

      // Batch-resolve variable IDs → token names (e.g. "Accent/On Accent")
      const varMap = {};
      await Promise.all([...varIds].map(async id => {
        try {
          const v = await figma.variables.getVariableByIdAsync(id);
          if (v) varMap[id] = v.name;
        } catch { /* external variable not accessible — treat as unresolved */ }
      }));

      figma.ui.postMessage({ type: 'audit-data', nodes: allNodes, varMap, nodeCount: allNodes.length });
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
      const node = figma.getNodeById(msg.nodeId);
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

import { CapabilityError, type DeviceSelector, type UiNode } from '../../types.js';

const BOUNDS_RE = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/;

function decode(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#10;/g, '\n')
    .replace(/&#13;/g, '\r');
}

function attribute(attrs: string, name: string): string | undefined {
  const match = new RegExp(`${name}="([^"]*)"`).exec(attrs);
  return match ? decode(match[1] ?? '') : undefined;
}

export function parseUiDump(xml: string): UiNode[] {
  const nodes: UiNode[] = [];
  for (const match of xml.matchAll(/<node\b([^>]*?)\/?>/g)) {
    const attrs = match[1] ?? '';
    const bounds = BOUNDS_RE.exec(attribute(attrs, 'bounds') ?? '');
    if (!bounds) continue;
    const node: UiNode = {
      clickable: attribute(attrs, 'clickable') === 'true',
      bounds: {
        x1: Number(bounds[1]),
        y1: Number(bounds[2]),
        x2: Number(bounds[3]),
        y2: Number(bounds[4]),
      },
    };
    const text = attribute(attrs, 'text');
    const resourceId = attribute(attrs, 'resource-id');
    const contentDesc = attribute(attrs, 'content-desc');
    const className = attribute(attrs, 'class');
    if (text) node.text = text;
    if (resourceId) node.resourceId = resourceId;
    if (contentDesc) node.contentDesc = contentDesc;
    if (className) node.className = className;
    nodes.push(node);
  }
  return nodes;
}

export function nodeCenter(node: UiNode): { x: number; y: number } {
  return {
    x: Math.round((node.bounds.x1 + node.bounds.x2) / 2),
    y: Math.round((node.bounds.y1 + node.bounds.y2) / 2),
  };
}

/** Exact-field selector; clickable nodes win over static ancestors. */
export function findNode(nodes: readonly UiNode[], selector: DeviceSelector): UiNode {
  const matches = nodes.filter(
    (node) =>
      (selector.text === undefined || node.text === selector.text) &&
      (selector.resourceId === undefined || node.resourceId === selector.resourceId) &&
      (selector.contentDesc === undefined || node.contentDesc === selector.contentDesc) &&
      (selector.className === undefined || node.className === selector.className),
  );
  const chosen = matches.find((node) => node.clickable) ?? matches[0];
  if (!chosen) throw new CapabilityError('selector_not_found', 'no node matched the selector');
  return chosen;
}

// Runs the JavaScript of an n8n Code node straight from the exported workflow JSON,
// so the workflow file stays the single source of truth for the business rules.
import { readFileSync } from 'node:fs';
import { DateTime } from 'luxon';

const wrap = (items) => ({
  all: () => items,
  first: () => items[0],
  item: items[0],
});

/**
 * Runs a Code node on full n8n items ({ json, binary }) and returns the items it produced.
 * @param {string} workflow  file name in workflows/
 * @param {string} nodeName  Code node name
 * @param {object[]} items   incoming items
 * @param {object} [nodes]   outputs of earlier nodes for $('Node name'): { name: [json, ...] }
 * @param {object} [opts]    { now: 'ISO date' } pins $now
 */
export function runItems(workflow, nodeName, items, nodes = {}, opts = {}) {
  const wf = JSON.parse(readFileSync(new URL(`../workflows/${workflow}`, import.meta.url)));
  const node = wf.nodes.find((n) => n.name === nodeName);
  if (!node) throw new Error(`No node "${nodeName}" in ${workflow}`);

  const $input = wrap(items);
  const $ = (name) => {
    if (!(name in nodes)) throw new Error(`Test did not provide output for node "${name}"`);
    return wrap(nodes[name].map((json) => ({ json })));
  };
  const $now = opts.now ? DateTime.fromISO(opts.now) : DateTime.now();

  const fn = new Function('$input', '$', 'DateTime', '$now', node.parameters.jsCode);
  return fn($input, $, DateTime, $now);
}

/** Same as runItems, for json-only items: takes and returns plain json payloads. */
export function runCode(workflow, nodeName, input, nodes = {}, opts = {}) {
  return runItems(workflow, nodeName, input.map((json) => ({ json })), nodes, opts).map((item) => item.json);
}

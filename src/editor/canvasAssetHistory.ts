import { Extension, type JSONContent } from '@tiptap/core';
import { isHistoryTransaction } from '@tiptap/pm/history';
import type { Node } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Transform } from '@tiptap/pm/transform';
import { canvasDocumentSupported } from './canvasCapacity';
import { getMessages } from '../i18n';
import { hydrateDocumentAssets, rebaseDocumentAssetReferences, renameDocumentAssetReferences } from '../lib/files';

export type CanvasAssetTransition = { oldPath: string; newPath: string; operation: 'rebase' | 'rename' };
export const canvasAssetTransitionKey = new PluginKey<undefined>('canvasAssetTransition');
export const canvasAssetRefresh = 'canvasAssetRefresh';
const normalizedAssetHistory = 'normalizedAssetHistory';

export const canvasAssetAttributes: Record<string, readonly string[]> = {
  image: ['src', 'originalSrc', 'basePath'],
  htmlPreview: ['source', 'basePath'],
  inlineHtmlPreview: ['source', 'basePath'],
  unsupportedMarkdown: ['source'],
};

function assetKey(node: Node | JSONContent): string {
  const type = typeof node.type === 'string' ? node.type : node.type?.name;
  return JSON.stringify([type, ...(canvasAssetAttributes[type ?? ''] ?? []).map((name) => node.attrs?.[name])]);
}

type Refresh = { replacements: Map<string, JSONContent['attrs']> };
type AssetEvent = CanvasAssetTransition | Refresh;

/** Asset moves belong to the file, including images currently held by Undo. */
export const CanvasAssetHistory = Extension.create<{ onError: (message: string) => void }>({
  name: 'canvasAssetHistory',
  addOptions: () => ({ onError: () => undefined }),
  addProseMirrorPlugins() {
    const events: AssetEvent[] = [];
    const origins = new WeakMap<Node, number>();
    const knownSources = new Map<string, number>();
    const remember = (document: Node) => document.descendants((node) => {
      if (!canvasAssetAttributes[node.type.name]) return;
      if (!origins.has(node)) origins.set(node, events.length);
      if (!knownSources.has(assetKey(node))) knownSources.set(assetKey(node), events.length);
    });

    const prepared = new WeakMap<Node, Transform>();
    const normalize = (document: Node): Transform => {
      const normalized = new Transform(document);
      document.descendants((node, position) => {
        const names = canvasAssetAttributes[node.type.name];
        if (!names) return;
        let restored = node.toJSON() as JSONContent;
        const revision = origins.get(node) ?? knownSources.get(assetKey(node)) ?? events.length;
        for (const event of events.slice(revision)) {
          if ('replacements' in event) {
            const replacement = event.replacements.get(assetKey(restored));
            if (replacement) restored = { ...restored, attrs: { ...restored.attrs, ...replacement } };
          } else {
            const transform = event.operation === 'rename' ? renameDocumentAssetReferences : rebaseDocumentAssetReferences;
            const portable = transform({ type: 'doc', content: [restored] }, event.oldPath, event.newPath);
            restored = hydrateDocumentAssets(portable, event.newPath).content![0];
          }
        }
        for (const name of names) {
          const value = restored.attrs?.[name] ?? node.type.spec.attrs?.[name]?.default;
          if (JSON.stringify(value) !== JSON.stringify(node.attrs[name])) {
            normalized.setNodeAttribute(position, name, value);
          }
        }
      });
      return normalized;
    };

    return [new Plugin({
      key: canvasAssetTransitionKey,
      filterTransaction: (transaction) => {
        if (!transaction.docChanged || !isHistoryTransaction(transaction)) return true;
        try {
          const normalized = normalize(transaction.doc);
          if (!canvasDocumentSupported(normalized.doc)) {
            this.options.onError(getMessages().canvasEditLimited);
            return false;
          }
          prepared.set(transaction.doc, normalized);
          return true;
        } catch (error) {
          // Reject before history or the editor adopts any part of the Undo.
          this.options.onError(error instanceof Error ? error.message : String(error));
          return false;
        }
      },
      state: {
        init: (_config, state) => { remember(state.doc); },
        apply: (transaction, _value, oldState) => {
          const transition = transaction.getMeta(canvasAssetTransitionKey) as CanvasAssetTransition | undefined;
          if (transition) events.push(transition);
          if (transaction.getMeta(canvasAssetRefresh)) {
            const replacements = new Map<string, JSONContent['attrs']>();
            oldState.doc.descendants((node, position) => {
              const names = canvasAssetAttributes[node.type.name];
              const next = transaction.doc.nodeAt(position);
              if (!names || !next || node.type !== next.type || assetKey(node) === assetKey(next)) return;
              replacements.set(assetKey(node), Object.fromEntries(names.map((name) => [name, next.attrs[name]])));
            });
            if (replacements.size) events.push({ replacements });
          }
          if (transaction.docChanged && !isHistoryTransaction(transaction)) remember(transaction.doc);
        },
      },
      appendTransaction(transactions, _oldState, state) {
        if (transactions.some((transaction) => transaction.getMeta(normalizedAssetHistory)) ||
          !transactions.some(isHistoryTransaction)) return;
        const transaction = state.tr;
        const normalized = prepared.get(state.doc) ?? normalize(state.doc);
        for (const step of normalized.steps) transaction.step(step);
        if (!transaction.docChanged) return;
        transaction.setMeta('addToHistory', false).setMeta(normalizedAssetHistory, true).setMeta('skipTypingNormalization', true);
        return transaction;
      },
    })];
  },
});

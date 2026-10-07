import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import { UIBroker } from './broker.ts';

/** Isolated compatibility decorator for Pi's mutable shared TUI context.
 * Not a public host interceptor. RPC/headless contexts are deliberately untouched.
 */
export function installUIProxy(ui: ExtensionUIContext, broker: UIBroker, afterNotify?: () => void): () => void {
  const originals = new Map<string, { descriptor: PropertyDescriptor; replacement: Function }>();
  const target = ui as any;
  const wrap = (key: string, factory: (original: Function) => Function) => {
    const descriptor = Object.getOwnPropertyDescriptor(ui, key);
    if (!descriptor || typeof descriptor.value !== 'function' || !descriptor.configurable) throw new Error(`UI proxy cannot wrap ${key}`);
    const replacement = factory(descriptor.value.bind(ui));
    originals.set(key, { descriptor, replacement });
    Object.defineProperty(ui, key, { ...descriptor, value: replacement });
  };
  const restore = () => {
    for (const [key, { descriptor, replacement }] of originals) {
      if (target[key] === replacement) Object.defineProperty(ui, key, descriptor);
    }
    originals.clear();
  };
  try {
    wrap('select', original => (title: string, options: string[], opts: any) => {
      const choices = [...options];
      return broker.dialog('select', { title, options: choices }, opts, merged => original(title, choices, merged));
    });
    wrap('confirm', original => (title: string, message: string, opts: any) =>
      broker.dialog('confirm', { title, message }, opts, merged => original(title, message, merged)));
    wrap('input', original => (title: string, placeholder: string, opts: any) =>
      broker.dialog('input', { title, placeholder }, opts, merged => original(title, placeholder, merged)));
    // Native editor has no AbortSignal/dismiss handle; remote completion is unsafe.
    wrap('editor', original => (title: string, prefill: string) => broker.localOnly('editor', title, () => original(title, prefill)));
    wrap('custom', original => (...args: any[]) => broker.localOnly('custom', 'Custom terminal UI — complete locally', () => original(...args)));
    wrap('notify', original => (message: string, type?: string) => {
      original(message, type);
      broker.notify(message, type);
      try { afterNotify?.(); } catch { /* status inspection must not affect the local notification */ }
    });
    wrap('setStatus', original => (key: string, text?: string) => { original(key, text); broker.setStatus(key, text); });
  } catch (error) { restore(); throw error; }
  return restore;
}

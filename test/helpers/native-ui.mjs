import { ExtensionRunner, createExtensionRuntime, SessionManager, initTheme } from '@earendil-works/pi-coding-agent';
import { Container, Text } from '@earendil-works/pi-tui';
import { InteractiveMode } from '../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js';
import { UIBroker } from '../../extensions/daemon/ui/broker.ts';
import { installUIProxy } from '../../extensions/daemon/ui/adapter.ts';
initTheme('dark', false);

export function nativeUI(publish = () => {}, loaded) {
  // Use the installed host's real UI factory, selector/input components and
  // AbortSignal cleanup. Only the terminal renderer is a test fixture.
  const mode = Object.create(InteractiveMode.prototype);
  mode.ui = { setFocus() {}, requestRender() {}, terminal: { setTitle() {} } };
  mode.editor = new Text('Main editor');
  mode.editorContainer = new Container();
  mode.showExtensionNotify = () => {};
  mode.statuses = [];
  mode.setExtensionStatus = (...args) => mode.statuses.push(args);
  const runtime = loaded?.runtime ?? createExtensionRuntime();
  const runner = new ExtensionRunner(loaded?.extensions ?? [], runtime, process.cwd(), SessionManager.inMemory(), {});
  runner.setUIContext(mode.createExtensionUIContext(), 'tui');
  const ctx = runner.createContext();
  const broker = loaded ? undefined : new UIBroker(publish);
  const restore = broker ? installUIProxy(ctx.ui, broker) : () => {};
  return { mode, runner, runtime, ctx, broker, restore };
}


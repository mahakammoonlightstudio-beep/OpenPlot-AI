/**
 * Server-render smoke entry: renders the app shell and the v1.2 views with
 * react-dom/server. Effects do not run, but component bodies, hooks, imports
 * and initial state do — enough to catch broken imports, bad hook order and
 * render-time crashes without a display server.
 */
import { renderToString } from 'react-dom/server';
import App from '../../src/App';
import { StoryAgentView } from '../../src/components/StoryAgentView';
import { StoryBibleView } from '../../src/components/StoryBibleView';
import { SettingsView } from '../../src/components/SettingsView';
import { ChatView } from '../../src/components/ChatView';

export function smoke(): Record<string, string> {
  const out: Record<string, string> = {};
  const render = (name: string, node: any) => {
    try {
      out[name] = renderToString(node);
    } catch (e: any) {
      out[name + 'Error'] = String(e?.stack || e);
    }
  };
  render('app', <App />);
  render('agent', <StoryAgentView />);
  render('story', <StoryBibleView />);
  render('settings', <SettingsView initialSection="data" />);
  render('chat', <ChatView />);
  return out;
}

import { useEffect, useRef } from 'react';
import { Icon } from '../Icons';
import { hardenLinks } from '../../markdown';
import { hydrateRemoteImages } from '../../lib/remoteImages';
import type { ToolStep } from '../../lib/toolProgress';
import { ThinkingBlock } from './MessageBubble';
import { ToolLog } from './ToolLog';
import { SearchLog, isWebTool } from './SearchLog';

/**
 * The reply that is landing right now. Kept out of ChatView so the transcript
 * render only has to hand over the current stream state — the bubble has no
 * other dependencies (no store reads, no callbacks).
 *
 * Web research is split out of the agent panel: two boxes, each with one job.
 */
export function StreamingBubble({
  streaming, html, text, think, tools, steps, thinkingDisplay
}: {
  streaming: boolean;
  /** Throttled HTML of the streamed text (re-parsed once per frame). */
  html: string;
  text: string;
  think: string;
  tools: string[];
  steps: ToolStep[];
  thinkingDisplay?: 'auto' | 'expanded' | 'collapsed';
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  // A reply is clickable while it streams — links get the same treatment as a
  // finished message, not only after it lands.
  useEffect(() => {
    if (!contentRef.current) return;
    hardenLinks(contentRef.current);
    hydrateRemoteImages(contentRef.current);
  }, [html]);
  if (!streaming) return null;
  const allSteps = steps || [];
  const webSteps = allSteps.filter((s) => s.kind === 'web');
  const otherSteps = allSteps.filter((s) => s.kind !== 'web');
  const webNames = (tools || []).filter(isWebTool);
  const otherNames = (tools || []).filter((n) => !isWebTool(n));
  const showSearch = webSteps.length > 0 || webNames.length > 0;
  const showTools = otherSteps.length > 0 || otherNames.length > 0;

  return (
    <div className="msg assistant streaming">
      <div className="avatar"><Icon name="quill" size={15} /></div>
      <div className="bubble">
        {think && <ThinkingBlock text={think} live display={thinkingDisplay} />}
        {showSearch && <SearchLog names={webNames} steps={webSteps} live />}
        {showTools && <ToolLog tools={otherNames} steps={otherSteps} live />}
        {text
          ? <div className="content" ref={contentRef} dangerouslySetInnerHTML={{ __html: html }} />
          : <div className="typing-dots"><span /><span /><span /></div>}
      </div>
    </div>
  );
}

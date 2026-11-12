import { useVirtualizer } from '@tanstack/react-virtual';
import type { BuddyContext } from '@unleashd/shared';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { MessageGroup } from '../utils/chat-message-groups';
import { messageTranscriptContent } from '../utils/conversation-transcript';
import { TranscriptGroup } from '../views/transcript/TranscriptGroup';
import { BuddyConvoHeader } from './BuddyConvoHeader';

// =============================================================================
// VirtualizedMessageList: the DESKTOP transcript container. Renders large
// message lists efficiently using @tanstack/react-virtual, virtualizing at the
// message-group level. Rows are views/transcript/TranscriptGroup, shared with
// the mobile windowed list; only this container is desktop-only.
//
// KEY DESIGN:
// - Uses measureElement for accurate dynamic heights after Markdown renders
// - Sticky-bottom mode: auto-scrolls during streaming when user is near bottom
// - Instant scroll on conversation mount (useLayoutEffect avoids flash)
// - overscan: 3 items for smooth scrolling without excessive DOM
// =============================================================================

interface VirtualizedMessageListProps {
  messageGroups: MessageGroup[];
  isRunning: boolean;
  /** Owning turn still active (isRunning || isStreaming at the call site).
      Feeds the in-bubble working indicator on the live assistant response. */
  isTurnActive?: boolean;
  lastMessageRef: React.RefObject<HTMLDivElement | null>;
  onScrollStateChange: (isNearBottom: boolean, showScrollButton: boolean) => void;
  conversationId: string;
  markMessagesSeen: (id: string, lastIndex: number) => void;
  totalMessageCount: number;
  scrollToBottomRef?: React.MutableRefObject<(() => void) | null>;
  /** Conversation working directory — used to resolve relative file paths in previews. */
  workingDirectory: string;
  buddyContext?: BuddyContext;
}

// Estimate height based on content — rough approximation before measurement
function estimateGroupSize(group: MessageGroup): number {
  if (group.type === 'assistant') {
    return (
      48 +
      group.parts.reduce(
        (height, part) =>
          height +
          (part.type === 'tool_calls'
            ? 24
            : Math.min(
                40 + Math.ceil(messageTranscriptContent(part.message).length / 100) * 20,
                600
              )),
        0
      )
    );
  }
  return group.messages.reduce(
    (height, msg) =>
      height + Math.min(80 + Math.ceil(messageTranscriptContent(msg).length / 100) * 20, 600),
    0
  );
}

export function VirtualizedMessageList({
  messageGroups,
  isRunning,
  isTurnActive,
  lastMessageRef,
  onScrollStateChange,
  conversationId,
  markMessagesSeen,
  totalMessageCount,
  scrollToBottomRef,
  workingDirectory,
  buddyContext,
}: VirtualizedMessageListProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const stickyBottomRef = useRef(true);
  // Track conversation ID to detect switches
  const prevConversationIdRef = useRef<string | null>(null);

  const contextItemCount = buddyContext ? 1 : 0;
  const totalItems = messageGroups.length + contextItemCount;
  // Read once, when the virtualizer first needs a scroll offset. A memo here
  // re-summed every group on each streaming frame for a value used at mount.
  const estimateInitialOffset = () => {
    let total = 0;
    if (buddyContext) total += 88;
    for (const group of messageGroups) total += estimateGroupSize(group);
    return total;
  };

  const virtualizer = useVirtualizer({
    count: totalItems,
    getItemKey: (index) =>
      index < contextItemCount
        ? `context-${index}`
        : `message-${messageGroups[index - contextItemCount].firstMessageIndex ?? index}`,
    getScrollElement: () => parentRef.current,
    // Conversations open at the newest message. Starting the virtualizer at
    // offset zero briefly rendered the oldest item before the layout effect
    // scrolled down; a large first prompt could spend hundreds of milliseconds
    // in Markdown parsing even though the user never saw it.
    initialOffset: estimateInitialOffset,
    estimateSize: (index) => {
      if (buddyContext && index === 0) return 88;
      const groupIndex = index - contextItemCount;
      return estimateGroupSize(messageGroups[groupIndex]);
    },
    overscan: 3,
    measureElement: (element) => {
      // Measure actual DOM height for accurate positioning
      return element.getBoundingClientRect().height;
    },
  });

  // Scroll to bottom instantly on conversation mount (before paint)
  useLayoutEffect(() => {
    const isNewConversation = prevConversationIdRef.current !== conversationId;
    prevConversationIdRef.current = conversationId;

    if (isNewConversation && totalItems > 0) {
      // Instant scroll to bottom on conversation switch
      virtualizer.scrollToIndex(totalItems - 1, { align: 'end' });
      stickyBottomRef.current = true;
    }
  }, [conversationId, totalItems, virtualizer]);

  // Auto-scroll during streaming when sticky-bottom is true
  useEffect(() => {
    if (stickyBottomRef.current && totalItems > 0) {
      virtualizer.scrollToIndex(totalItems - 1, {
        align: 'end',
        behavior: isRunning ? 'auto' : 'smooth',
      });
    }
  }, [totalItems, isRunning, virtualizer]);

  // Track scroll position for sticky-bottom mode
  const handleScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const isNearBottom = distanceFromBottom < 150;
    stickyBottomRef.current = isNearBottom;
    onScrollStateChange(isNearBottom, distanceFromBottom >= 200);
  }, [onScrollStateChange]);

  // IntersectionObserver for NEW badge — mark messages seen when last is visible
  useEffect(() => {
    if (totalMessageCount === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            markMessagesSeen(conversationId, totalMessageCount - 1);
          }
        }
      },
      { threshold: 0.5 }
    );

    if (lastMessageRef.current) {
      observer.observe(lastMessageRef.current);
    }

    return () => observer.disconnect();
  }, [conversationId, totalMessageCount, markMessagesSeen, lastMessageRef]);

  // Expose scrollToBottom function via ref
  // NOTE: Must use totalItems (not messageGroups.length) because when buddyContext
  // is present, the virtualizer has messageGroups.length + 1 items. Using
  // messageGroups.length - 1 would scroll to the second-to-last item, missing the
  // final message group.
  useEffect(() => {
    if (scrollToBottomRef) {
      scrollToBottomRef.current = () => {
        if (totalItems > 0) {
          virtualizer.scrollToIndex(totalItems - 1, { align: 'end', behavior: 'smooth' });
          stickyBottomRef.current = true;
        }
      };
    }
    return () => {
      if (scrollToBottomRef) {
        scrollToBottomRef.current = null;
      }
    };
  }, [scrollToBottomRef, totalItems, virtualizer]);

  const items = virtualizer.getVirtualItems();

  return (
    <div
      ref={parentRef}
      className="messages-container"
      onScroll={handleScroll}
      style={{ overflowY: 'auto' }}
    >
      {totalItems === 0 ? null : (
        <div
          className="virtual-list-inner chat-reading-column"
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {items.map((virtualItem) => {
            if (buddyContext && virtualItem.index === 0) {
              return (
                <div
                  key={virtualItem.key}
                  data-index={virtualItem.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                >
                  <BuddyConvoHeader context={buddyContext} />
                </div>
              );
            }

            const groupIndex = virtualItem.index - contextItemCount;
            const group = messageGroups[groupIndex];
            const isLastGroup = groupIndex === messageGroups.length - 1;

            return (
              <div
                key={virtualItem.key}
                data-index={virtualItem.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualItem.start}px)`,
                }}
              >
                <TranscriptGroup
                  presentation="hover"
                  group={group}
                  isLastGroup={isLastGroup}
                  lastMessageRef={lastMessageRef}
                  workingDirectory={workingDirectory}
                  // Only the last group can be live; passing the flag to every
                  // group re-rendered the whole list when a turn started or ended.
                  isLiveTurn={isTurnActive && isLastGroup}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

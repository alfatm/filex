/**
 * The one width the layout changes at — see DESIGN-SPEC §10.
 *
 * ONE source for both sides of the app: Tailwind's `screens` (so `md:` utilities mean this number) and
 * `useBreakpoint` (so a component asking "which layout is this?" gets the same answer). They used to be a literal
 * in `tailwind.config.js` and another literal in `Sidebar.vue`, which is a drift waiting to happen: a rail that
 * appears at 768 while the utilities around it switch at 1024 is a layout nobody designed.
 */
export const BREAKPOINTS = { md: 768 } as const;

/** The two targets the reference is drawn for: phone portrait, and the desktop the spec is measured at. */
export type Layout = 'mobile' | 'desktop';

export const MEDIA: Record<Layout, string> = {
  mobile: `(max-width: ${BREAKPOINTS.md - 1}px)`,
  desktop: `(min-width: ${BREAKPOINTS.md}px)`,
};

/**
 * A finger rather than a mouse.
 *
 * Not the same question as "how wide is the window": a 1000px tablet is touch and a 1000px window on a laptop is
 * not, and the two need different interactions — a tap opens where a double-click does, a long press stands in for
 * the right button, and a control that only appears on hover appears never.
 */
export const TOUCH = '(pointer: coarse)';

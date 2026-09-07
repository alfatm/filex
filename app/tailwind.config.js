/** @type {import('tailwindcss').Config} */
// Every value maps onto a CSS variable declared in src/design/tokens.css, so
// the spec's token table stays the single place where colours are defined.
//
// The variables hold whole colours (light-dark() pairs), not channel triplets,
// so the opacity modifier has nothing to attach to: `bg-bg/90` compiles to a
// dropped declaration, not a translucent background. Use a solid token, or
// `bg-[color-mix(in_srgb,var(--c-bg)_90%,transparent)]` when translucency is
// really needed.
export default {
  content: ['./index.html', './src/**/*.{vue,ts}'],
  theme: {
    colors: {
      transparent: 'transparent',
      current: 'currentColor',
      white: '#ffffff',
      black: '#000000',
      bg: 'var(--c-bg)',
      'bg-sidebar': 'var(--c-bg-sidebar)',
      'bg-muted': 'var(--c-bg-muted)',
      border: 'var(--c-border)',
      'border-soft': 'var(--c-border-soft)',
      'border-hover': 'var(--c-border-hover)',
      text: 'var(--c-text)',
      'text-2': 'var(--c-text-2)',
      'text-3': 'var(--c-text-3)',
      primary: {
        DEFAULT: 'var(--c-primary)',
        hover: 'var(--c-primary-hover)',
        soft: 'var(--c-primary-soft)',
        ring: 'var(--c-primary-ring)',
        tint: 'var(--c-primary-tint)',
      },
      folder: 'var(--c-folder)',
      success: 'var(--c-success)',
      highlight: 'var(--c-highlight)',
      danger: 'var(--c-danger)',
      'hover-card': 'var(--c-hover-card)',
      'hover-row': 'var(--c-hover-row)',
      overlay: 'var(--c-overlay)',
    },
    borderRadius: {
      none: '0',
      sm: '6px',
      DEFAULT: '8px',
      md: '10px',
      lg: '12px',
      xl: '14px',
      '2xl': '16px',
      full: '9999px',
    },
    boxShadow: {
      none: 'none',
      modal: 'var(--shadow-modal)',
      menu: 'var(--shadow-menu)',
    },
    fontFamily: {
      sans: ['var(--font)'],
    },
    extend: {
      fontSize: {
        // px scale from the spec; line-height 1 for single-line rows is set per element.
        '12': ['12px', '1.5'],
        '13': ['13px', '1.5'],
        '14': ['14px', '1.5'],
        '15': ['15px', '1.5'],
        '16': ['16px', '1.5'],
        '17': ['17px', '1.5'],
        '18': ['18px', '1.5'],
        '20': ['20px', '1.5'],
        '22': ['22px', '1.5'],
      },
    },
  },
  plugins: [],
};

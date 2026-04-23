/**
 * Tailwind config for the AI Chat Overlay userscript.
 *
 * The compiled CSS is injected into a closed Shadow Root by the userscript,
 * so we no longer need selector-level scoping (`important: '#aicx-root'`).
 * The Shadow Root already isolates styles both ways, so utilities here are
 * emitted plain and gain their specificity from the browser's style scoping.
 */
const emSpacing = {
  '0': '0px', 'px': '1px',
  '0.5': '0.125em', '1': '0.25em', '1.5': '0.375em', '2': '0.5em',
  '2.5': '0.625em', '3': '0.75em', '3.5': '0.875em', '4': '1em',
  '5': '1.25em', '6': '1.5em', '7': '1.75em', '8': '2em',
  '9': '2.25em', '10': '2.5em', '11': '2.75em', '12': '3em',
  '14': '3.5em', '16': '4em', '20': '5em', '24': '6em',
  '28': '7em', '32': '8em', '36': '9em', '40': '10em',
  '44': '11em', '48': '12em', '52': '13em', '56': '14em',
  '60': '15em', '64': '16em', '72': '18em', '80': '20em', '96': '24em',
};

const path = require('path');
module.exports = {
  content: [path.resolve(__dirname, '../ai-chat.user.js')],
  darkMode: 'class',
  corePlugins: { preflight: false },
  theme: {
    spacing: emSpacing,
    borderRadius: {
      'none': '0px',
      'sm': '0.125em',
      DEFAULT: '0.25em',
      'md': '0.375em',
      'lg': '0.5em',
      'xl': '0.75em',
      '2xl': '1em',
      '3xl': '1.5em',
      'full': '9999px',
    },
    maxWidth: {
      '0': '0em',
      'none': 'none',
      'xs': '20em', 'sm': '24em', 'md': '28em', 'lg': '32em',
      'xl': '36em', '2xl': '42em', '3xl': '48em', '4xl': '56em',
      '5xl': '64em', '6xl': '72em', '7xl': '80em',
      'full': '100%', 'min': 'min-content', 'max': 'max-content', 'fit': 'fit-content',
      'prose': '65ch',
      'screen-sm': '640px', 'screen-md': '768px', 'screen-lg': '1024px',
      'screen-xl': '1280px', 'screen-2xl': '1536px',
    },
    // fontSize uses absolute px values on purpose. rem-based defaults
    // resolve against the host page's <html> font-size, so sites that use
    // CSS resets like `html { font-size: 10px !important }` would shrink
    // every text-* utility inside the overlay. Pinning :host font-size
    // alone isn't enough because rem ignores shadow-local roots. Absolute
    // px sidesteps the whole inheritance chain and reproduces the legacy
    // px-override layout exactly.
    fontSize: {
      'xs':   ['12px', { lineHeight: '16px' }],
      'sm':   ['14px', { lineHeight: '20px' }],
      'base': ['16px', { lineHeight: '24px' }],
      'lg':   ['18px', { lineHeight: '28px' }],
      'xl':   ['20px', { lineHeight: '28px' }],
      '2xl':  ['24px', { lineHeight: '32px' }],
      '3xl':  ['30px', { lineHeight: '36px' }],
      '4xl':  ['36px', { lineHeight: '40px' }],
    },
    lineHeight: {
      'none': '1', 'tight': '1.25', 'snug': '1.375',
      'normal': '1.5', 'relaxed': '1.625', 'loose': '2',
      '3': '0.75em', '4': '1em', '5': '1.25em', '6': '1.5em',
      '7': '1.75em', '8': '2em', '9': '2.25em', '10': '2.5em',
    },
    extend: {
      fontFamily: {
        sans: ['system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Helvetica', 'Arial', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
    },
  },
};

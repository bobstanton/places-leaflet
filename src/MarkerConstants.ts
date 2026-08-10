// These values are used both in CSS and JavaScript for anchor calculations.
export const MarkerConstants = {
  // Desktop sizes (>= 1024px)
  desktop: {
    containerSize: 36,      // pixels - icon container width/height
    fontSize: 20,           // pixels - emoji font size
    labelOffset: 8,         // gap between icon and label
  },
  // Tablet sizes (768px - 1023px)
  tablet: {
    containerSize: 38,
    fontSize: 22,
    labelOffset: 8,
  },
  // Mobile sizes (< 768px)
  mobile: {
    containerSize: 40,
    fontSize: 24,
    labelOffset: 8,
  },
  // Label settings (consistent across breakpoints unless noted)
  label: {
    fontSize: 13,
    mobileFontSize: 14,
    tabletFontSize: 13,
    maxWidth: 160,
    mobileMaxWidth: 185,
    tabletMaxWidth: 170,
    color: '#d73027',
  }
} as const;

export type MarkerBreakpoint = 'desktop' | 'tablet' | 'mobile';

// Used by Leaflet's DivIcon iconAnchor option.
export function getIconAnchor(breakpoint: MarkerBreakpoint = 'desktop'): [number, number] {
  const size = MarkerConstants[breakpoint].containerSize;
  return [size / 2, size / 2];
}

// Positions the popup above the icon.
export function getPopupAnchor(breakpoint: MarkerBreakpoint = 'desktop'): [number, number] {
  const size = MarkerConstants[breakpoint].containerSize;
  return [0, -(size / 2)];
}


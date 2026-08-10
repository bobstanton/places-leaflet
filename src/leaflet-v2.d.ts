import 'leaflet';

// Leaflet 2 alpha runtime options not yet published by DefinitelyTyped.
declare module 'leaflet' {
  interface ImageOverlayOptions {
    decoding?: 'sync' | 'async' | 'auto';
  }

  interface PopupOptions {
    trackResize?: boolean;
  }
}

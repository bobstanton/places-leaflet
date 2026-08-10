import { loggedRequestUrl as requestUrl } from 'places-shared/utils';
import { TileLayer } from 'leaflet';
import type { Coords, DoneCallback, TileLayerOptions } from 'leaflet';
import { TileCache, type TileCacheFetchResult } from "places-shared/map";

interface ObsidianTileLayerOptions extends TileLayerOptions {
  cacheProviderId?: string;
  // Per-tile outcomes. Leaflet's own `tileerror` does not carry the URL or the HTTP status.
  onTileSuccess?: () => void;
  onTileFailure?: (url: string, error: unknown) => void;
}

// In Electron (Obsidian's desktop runtime), standard <img> tile loading sends
// no Referer header because the page origin is app:// - a non-HTTPS protocol.
// Any referrer policy that requires a secure origin (strict-origin-when-cross-origin,
// etc.) results in no Referer being sent to the tile server.
//
// OSM and other servers that enforce the Referer usage policy then block the request.
//
// requestUrl uses Electron's native net module, which can set arbitrary headers
// including Referer, bypassing the browser's forbidden-header restriction.
export class ObsidianTileLayer extends TileLayer {
  private cacheProviderId: string | undefined;
  private onTileSuccess: (() => void) | undefined;
  private onTileFailure: ((url: string, error: unknown) => void) | undefined;

  constructor(urlTemplate: string, options?: ObsidianTileLayerOptions) {
    super(urlTemplate, options);
    this.cacheProviderId = options?.cacheProviderId;
    this.onTileSuccess = options?.onTileSuccess;
    this.onTileFailure = options?.onTileFailure;
  }

  protected override createTile(coords: Coords, done: DoneCallback): HTMLElement {
    const tile = createEl('img');
    tile.alt = '';

    const url = this.getTileUrl(coords);

    this.fetchTile(url)
      .then(response => {
        const blob = new Blob([response.arrayBuffer], { type: response.contentType || 'image/png' });
        const objectUrl = URL.createObjectURL(blob);

        tile.addEventListener('load', () => {
          URL.revokeObjectURL(objectUrl);
          this.onTileSuccess?.();
          done(undefined, tile);
        }, { once: true });

        tile.addEventListener('error', () => {
          URL.revokeObjectURL(objectUrl);
          const error = new Error(`Failed to load tile: ${url}`);
          this.onTileFailure?.(url, error);
          done(error, tile);
        }, { once: true });

        tile.src = objectUrl;
      })
      .catch(err => {
        const error = err instanceof Error ? err : new Error(String(err));
        this.onTileFailure?.(url, error);
        done(error, tile);
      });

    return tile;
  }

  private fetchTile(url: string): Promise<TileCacheFetchResult> {
    const fetcher = async () => {
      const response = await requestUrl({ url, headers: { 'Referer': 'https://obsidian.md/' } });
      return {
        arrayBuffer: response.arrayBuffer,
        contentType: response.headers['content-type'] || 'image/png',
      };
    };

    return TileCache.isProviderEnabled(this.cacheProviderId)
      ? TileCache.getOrFetch(url, fetcher)
      : fetcher();
  }
}

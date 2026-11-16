import { loggedRequestUrl as requestUrl } from "places-shared/utils";
import { TileLayer } from 'leaflet';
import type { Coords, DoneCallback, TileLayerOptions } from 'leaflet';
import { TileCache, type TileCacheFetchResult } from "places-shared/obsidian/map";

interface ObsidianTileLayerOptions extends TileLayerOptions {
  cacheProviderId?: string;
  userAgent?: string;
  onTileSuccess?: () => void;
  onTileFailure?: (url: string, error: unknown) => void;
}

// Electron app:// requests omit Referer. Mobile requestUrl needs an application
// User-Agent to avoid OpenStreetMap returning an access-blocked image with HTTP 200.
export class ObsidianTileLayer extends TileLayer {
  private cacheProviderId: string | undefined;
  private userAgent: string | undefined;
  private onTileSuccess: (() => void) | undefined;
  private onTileFailure: ((url: string, error: unknown) => void) | undefined;

  constructor(urlTemplate: string, options?: ObsidianTileLayerOptions) {
    super(urlTemplate, options);
    this.cacheProviderId = options?.cacheProviderId;
    this.userAgent = options?.userAgent;
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
      const response = await requestUrl({
        url,
        headers: {
          'Referer': 'https://obsidian.md/',
          ...(this.userAgent ? { 'User-Agent': this.userAgent } : {}),
        },
      });

      return {
        arrayBuffer: response.arrayBuffer,
        contentType: response.headers['content-type'] || 'image/png',
      };
    };

    return TileCache.getOrFetch(url, fetcher, this.cacheProviderId);
  }
}

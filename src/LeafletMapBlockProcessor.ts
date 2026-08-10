import { isStyleHidden } from "places-shared/place";
import { App, Component, Platform } from "obsidian";
import { hasTrackData } from "places-shared/place";
import { type UnitsSystem } from "places-shared/units";
import { PlacesBoundingBox, convertPlacesToFeatureCollection } from "places-shared/geo";
import { TrackRenderer, TrackRenderResult, ColorSchemes, TRACK_STYLE_DEFAULTS, PlaceTrackState, TrackVisibilityResult, getPlaceId, getPlaceTrackRenderHash, getTrackStateRenderSignature, getStyleForPlace, mergeWithDefaults, extractTrackGeometry, type TrackColorBy } from "places-shared/track";
import { MapPlace, parseMapPlaceProperty, isGeoJSONOverlay, isImageOverlay, extendBoundingBoxWithOverlays, extractOverlayPointFeatures as extractOverlayPointFeaturesFromOverlays, getGeoJsonFeatures } from "places-shared/overlay";
import { prepareDirectionsOverlayNote, prepareIsochroneOverlayNote } from "places-shared/services";
import { appendTrackInspectionSection, dispatchMapTrackSelection, TrackDetailsPanel, TRACK_INSPECTION_REQUEST_EVENT, TRACK_POINT_SELECT_EVENT, TileFailureMonitor, describeTileFailure } from "places-shared/map";
import { MapContextMenu, MarkerStyleService, buildPopupContent, buildWaypointPopupContent, buildGeocodingSearchPopupContent, buildGeoJsonFeaturePopupContent, buildOverlayPointPopupContent, createSourceLinkClickHandler, resolveClusteringDecision, shouldClusterCount, classifyRouteOverlayFeature, type RouteOverlayFeatureMatch, MapStateManager, renderPopupContentAsync, getMapProviderState, setMapProviderState, clearMapProviderState, type MapProviderLifecycle, addSharedDebugOverlay, createLeafletDebugOverlayAdapter, runMarkerZoomTest, estimateInitialZoom, updateZoomContainerState, getZoomRangeClassNames, type ZoomRange, ensureMapSurfaceLifecycle, createMapCameraGuard, type MapCameraGuard } from "places-shared/map";
import { IPlaceExtensionSettings, type MapPrepareTimings, type MapRenderRequest, type ResolvedMapConfig, DEFAULT_GRADE_WINDOW, type MetricWindow } from "places-shared/settings";
import { MapBlockProcessorBase, CommonMapSettings, type MapControlHandle, type MapDataUpdateContext, type MapDataUpdateResult, type MapCameraApplyResult, type MapIncrementalUpdateCapabilities } from "places-shared/services";
import { hasOverlayRenderableChanges, hasTrackRenderableChanges, type MapCameraIntent } from "places-shared/render";
import { logger, createPerformanceMonitor, parseContributingFiles, scalarToString, renderMapSupplementalError, type PerformanceMonitor } from "places-shared/utils";
import { MarkerConstants, getIconAnchor, getPopupAnchor } from "./MarkerConstants";
import { getTileLayerConfig } from "./TileLayerStyles";
import { ObsidianTileLayer } from "./ObsidianTileLayer";
import { LabelVisibilityManager, type MarkerInfo } from "./LabelVisibilityManager";

import 'leaflet/dist/leaflet.css';
import { Map as LeafletMap, DivIcon, Marker, Polyline, LatLngBounds, LatLng, DomEvent, GeoJSON, Layer, CircleMarker, ImageOverlay, Popup, Canvas, LayerGroup, version as leafletVersion } from "leaflet";
import type { LeafletMouseEvent } from "leaflet";
import type * as GeoJson from "geojson";

interface MarkerCluster {
  center: LatLng;
  markerIndices: number[];
  bounds: LatLngBounds;
}

type PlacesGeoJsonFeature = GeoJson.Feature<GeoJson.Geometry, Record<string, unknown>>;
type PlacesGeoJsonFeatureCollection = GeoJson.FeatureCollection<GeoJson.Geometry, Record<string, unknown>>;

interface MarkerData {
  latlng: LatLng;
  html: string;
  place: MapPlace;
  feature: PlacesGeoJsonFeature;
}

const LEAFLET_PROVIDER_STATE_ID = 'leaflet';

const cameraGuards = new WeakMap<LeafletMap, MapCameraGuard>();

function cameraGuardFor(map: LeafletMap): MapCameraGuard {
  let guard = cameraGuards.get(map);
  if (!guard) {
    guard = createMapCameraGuard();
    cameraGuards.set(map, guard);
  }
  return guard;
}

// Run a code-initiated camera move under the camera guard: its move events
// neither persist viewport state nor register as user gestures. Guarded moves
// are non-animated, and Leaflet fires their events synchronously inside the call.
function withProgrammaticCamera(map: LeafletMap, move: () => void): void {
  const release = cameraGuardFor(map).beginProgrammaticMove();
  try {
    move();
  } finally {
    release();
  }
}
type VisibleTrackEntry = { place: MapPlace, settings: CommonMapSettings, trackLayers: Layer[], renderSignature: string };
type ZoomManagedLayer = Layer & { __placesZoomCleanup?: () => void };

// Leaflet attaches `feature` to layers it creates from GeoJSON, but its typings
// do not declare it. Manually created cluster markers follow the same convention.
interface FeatureLayer extends Layer {
  feature?: PlacesGeoJsonFeature;
}

function getLayerFeature(layer: Layer): PlacesGeoJsonFeature | undefined {
  return (layer as FeatureLayer).feature;
}

function normalizeGeoJsonFeature(feature: GeoJson.Feature): PlacesGeoJsonFeature {
  const properties = feature.properties;
  return {
    ...feature,
    properties: properties !== null && typeof properties === 'object' && !Array.isArray(properties)
      ? properties
      : {} };
}

// Escape route-label text before it is injected as innerHTML in a Leaflet DivIcon.
function escapeRouteLabelHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function finiteNumberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function buildLabelMarkerInfo(marker: Marker): MarkerInfo {
  const sortKey = getLayerFeature(marker)?.properties?.labelSortKey;
  return {
    marker,
    labelElement: marker.getElement()?.querySelector('.leaflet-marker-icon-label') as HTMLElement | null,
    ...(typeof sortKey === 'number' ? { labelSortKey: sortKey } : {}) };
}

// Groups markers by pixel distance at the current zoom.
class SimpleClusterGroup {
  private map: LeafletMap;
  private markerDataList: MarkerData[] = [];
  private createdMarkers = new Map<number, Marker>();
  private clusterMarkers: Marker[] = [];
  private clusterRadius: number;
  private currentlyShowingClusters = true;
  private bindPopupFn: (marker: Marker, place: MapPlace, feature: PlacesGeoJsonFeature) => void;

  constructor(map: LeafletMap, options: {
    clusterRadius?: number;
    bindPopup: (marker: Marker, place: MapPlace, feature: PlacesGeoJsonFeature) => void;
  }) {
    this.map = map;
    this.clusterRadius = options.clusterRadius || 50;
    this.bindPopupFn = options.bindPopup;
  }

  addMarkerData(dataList: MarkerData[]): void {
    this.markerDataList = dataList;
  }

  private getOrCreateMarker(index: number): Marker {
    let marker = this.createdMarkers.get(index);
    if (!marker) {
      const data = this.markerDataList[index];
      marker = new Marker(data.latlng, {
        icon: new DivIcon({
          className: "leaflet-marker-icon",
          html: data.html,
          iconSize: [120, MarkerConstants.desktop.containerSize],
          iconAnchor: getIconAnchor('desktop'),
          popupAnchor: getPopupAnchor('desktop')
        })
      });

      this.bindPopupFn(marker, data.place, data.feature);

      this.createdMarkers.set(index, marker);
    }
    return marker;
  }

  update(showClusters: boolean): void {
    this.clusterMarkers.forEach(m => m.remove());
    this.clusterMarkers = [];

    this.createdMarkers.forEach(marker => {
      if (this.map.hasLayer(marker)) {
        marker.remove();
      }
    });

    this.currentlyShowingClusters = showClusters;

    if (!showClusters) {
      const bounds = this.map.getBounds();
      this.markerDataList.forEach((data, index) => {
        if (bounds.contains(data.latlng)) {
          const marker = this.getOrCreateMarker(index);
          marker.addTo(this.map);
        }
      });
      return;
    }

    const clusters = this.computeClusters();

    clusters.forEach(cluster => {
      const clusterMarker = this.createClusterMarker(cluster);
      clusterMarker.addTo(this.map);
      this.clusterMarkers.push(clusterMarker);
    });
  }

  private computeClusters(): MarkerCluster[] {
    const clusters: MarkerCluster[] = [];
    const assigned = new Set<number>();
    const bounds = this.map.getBounds();

    const visibleIndices: number[] = [];
    this.markerDataList.forEach((data, index) => {
      if (bounds.contains(data.latlng)) {
        visibleIndices.push(index);
      }
    });

    for (const i of visibleIndices) {
      if (assigned.has(i)) continue;

      const data = this.markerDataList[i];
      const markerPoint = this.map.latLngToContainerPoint(data.latlng);

      const cluster: MarkerCluster = {
        center: data.latlng,
        markerIndices: [i],
        bounds: new LatLngBounds(data.latlng, data.latlng)
      };
      assigned.add(i);

      for (const j of visibleIndices) {
        if (assigned.has(j)) continue;

        const otherData = this.markerDataList[j];
        const otherPoint = this.map.latLngToContainerPoint(otherData.latlng);

        const distance = Math.sqrt(
          Math.pow(markerPoint.x - otherPoint.x, 2) +
          Math.pow(markerPoint.y - otherPoint.y, 2)
        );

        if (distance <= this.clusterRadius) {
          cluster.markerIndices.push(j);
          cluster.bounds.extend(otherData.latlng);
          assigned.add(j);
        }
      }

      if (cluster.markerIndices.length > 1) {
        let totalLat = 0, totalLng = 0;
        cluster.markerIndices.forEach(idx => {
          const d = this.markerDataList[idx];
          totalLat += d.latlng.lat;
          totalLng += d.latlng.lng;
        });
        cluster.center = new LatLng(
          totalLat / cluster.markerIndices.length,
          totalLng / cluster.markerIndices.length
        );
      }

      clusters.push(cluster);
    }

    return clusters;
  }

  private createClusterMarker(cluster: MarkerCluster): Marker {
    const count = cluster.markerIndices.length;
    const size = Math.min(40 + Math.log10(count) * 10, 60);

    const icon = new DivIcon({
      className: 'places-cluster-marker',
      html: `<div class="places-cluster-icon" style="width: ${size}px; height: ${size}px; line-height: ${size}px;">${count}</div>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2]
    });

    const marker = new Marker(cluster.center, { icon });

    marker.on('click', () => {
      this.map.fitBounds(cluster.bounds, { padding: [50, 50] });
    });

    return marker;
  }

  getVisibleMarkers(): Marker[] {
    if (this.currentlyShowingClusters) {
      return [];
    }
    const visible: Marker[] = [];
    this.createdMarkers.forEach(marker => {
      if (this.map.hasLayer(marker)) {
        visible.push(marker);
      }
    });
    return visible;
  }

  isShowingClusters(): boolean {
    return this.currentlyShowingClusters;
  }

  clear(): void {
    this.createdMarkers.forEach(m => m.remove());
    this.clusterMarkers.forEach(m => m.remove());
    this.createdMarkers.clear();
    this.clusterMarkers = [];
  }

  updateMarkerData(dataList: MarkerData[], showClusters: boolean): void {
    this.clear();
    this.markerDataList = dataList;
    this.update(showClusters);
  }

  getMarkerDataList(): MarkerData[] {
    return this.markerDataList;
  }
}

// State stored on container for incremental updates
interface LeafletMapState {
  map: LeafletMap;
  clusterGroup: SimpleClusterGroup;
  currentPlaces: MapPlace[];
  settings: CommonMapSettings;
  blockSettings: ResolvedMapConfig;
  runtime: MapRenderRequest['runtime'];
  geoJsonData: PlacesGeoJsonFeatureCollection;
  clusterThreshold: number;
  showClusters: boolean;
  codeBlockOverlayLayers: Layer[];
  geocodingMarkers: Marker[];
  lifecycle: MapProviderLifecycle;
}


// Leaflet propagates a layer's contextmenu to the map with `propagatedFrom`.
// The right-click handler looks the match up by layer instead of hit-testing
// geometry.
const routeOverlayMatchByLayer = new WeakMap<Layer, RouteOverlayFeatureMatch>();

// Visible to the menu builder for the duration of one contextmenu dispatch.
let lastRightClickedRouteOverlay: RouteOverlayFeatureMatch | undefined;

export class LeafletMapBlockProcessor extends MapBlockProcessorBase {
  private readonly trackDetailsPanels = new WeakMap<LeafletMap, TrackDetailsPanel>();
  app: App;
  extensionSettings: IPlaceExtensionSettings;

  // Per-map registry of currently rendered track trackLayers, keyed by place id.
  private visibleTracksByMap = new WeakMap<LeafletMap, Map<string, VisibleTrackEntry>>();

  private getVisibleTracks(map: LeafletMap): Map<string, VisibleTrackEntry> {
    let tracks = this.visibleTracksByMap.get(map);
    if (!tracks) {
      tracks = new Map<string, VisibleTrackEntry>();
      this.visibleTracksByMap.set(map, tracks);
    }
    return tracks;
  }

  constructor(app: App, extensionSettings: IPlaceExtensionSettings, private readonly units: UnitsSystem, developerMode = false) {
    super();
    this.app = app;
    this.extensionSettings = extensionSettings;
    this.developerMode = developerMode;
  }

  async processPlaceCodeBlock(places: MapPlace[], mapContainerElement: HTMLElement, request: MapRenderRequest) {
    const blockSettings = request.config;
    const runtime = request.runtime;
    const loadStartTime = Date.now();
    const perf = createPerformanceMonitor('leaflet-render', {
      provider: 'leaflet',
      source: runtime.source.path,
      places: places.length,
      overlays: runtime.overlays.length,
      trackDefaultVisibility: blockSettings.trackDefaultVisibility }, { enabled: this.developerMode });
    perf.mark('start');

    perf.measure('setup-container', () => DomEvent.disableClickPropagation(mapContainerElement));

    // Leaflet handles ALL touch gestures in JavaScript and needs touch-action: none.
    // The shared setupMapTouchHandlers() sets pan-x pan-y pinch-zoom, which hands
    // gestures to the browser and breaks Leaflet's own handling.
    mapContainerElement.addClass('places-leaflet-touch-target');

    const settings = perf.measure('extract-settings', () => this.extractCommonSettings(blockSettings, runtime));
    const isHeatmapLayer = blockSettings.heatmapLayer;

    if (blockSettings.css) {
      // User-authored per-block CSS cannot ship in the plugin stylesheet.
      // Keep it scoped to the rendered block's lifecycle.
      const styleEl = createEl('style');
      styleEl.textContent = blockSettings.css;
      mapContainerElement.appendChild(styleEl);
    }

    mapContainerElement.addClass('leaflet-map');

    if (blockSettings.height) {
      mapContainerElement.setCssStyles({ height: blockSettings.height });
    }

    const { featureCollection: geoJsonData, boundingBox } = perf.measure('prepare-geojson', () => convertPlacesToFeatureCollection(places));

    perf.measure('extend-bounds-with-overlays', () => this.extendBoundsWithOverlays(boundingBox, runtime.overlays, blockSettings.debug));

    const rawBounds = boundingBox.getConventionalLatLngBounds();
    const [[minLat, minLng], [maxLat, maxLng]] = rawBounds;
    const isValidBounds = isFinite(minLat) && isFinite(minLng) && isFinite(maxLat) && isFinite(maxLng);

    const latLngBounds = isValidBounds
      ? new LatLngBounds(rawBounds)
      : new LatLngBounds([[0, 0], [0, 0]]);
    const center = isValidBounds ? latLngBounds.getCenter() : { lat: 0, lng: 0 };

    const component = new Component();

    const tileConfig = this.getTileConfig(blockSettings.style);
    const mapMaxZoom = tileConfig.maxZoom;
    const cameraIntent = runtime.camera;
    const initialCenter = cameraIntent.kind === 'explicit' ? cameraIntent.center : undefined;
    const initialZoom = cameraIntent.kind === 'explicit' ? cameraIntent.zoom : undefined;
    const hasExplicitInitialView = cameraIntent.kind === 'explicit';
    const shouldFitInitialBounds = cameraIntent.kind === 'fit-data' && isValidBounds;
    const mapCenter = initialCenter
        ? new LatLng(initialCenter[1], initialCenter[0])
        : center;
    const mapZoom = initialZoom ?? estimateInitialZoom(boundingBox);

    const map = perf.measure('create-map', () => new LeafletMap(mapContainerElement, {
      center: mapCenter,
      zoom: mapZoom,
      minZoom: this.getMinZoom(blockSettings),
      maxZoom: mapMaxZoom,
      // Leaflet's window-resize invalidateSize runs outside the camera guard
      // and its move events would register as user gestures; the guarded
      // ResizeObserver here is the only resize driver.
      trackResize: false
    }), { initialZoom: mapZoom });
    logger.scope('MapSurface').debug('Leaflet map runtime created', {
      source: runtime.source.path,
      engine: 'leaflet',
      engineVersion: leafletVersion,
      mapClass: map.constructor?.name ?? 'unknown',
      places: places.length });

    const surfaceLifecycle = ensureMapSurfaceLifecycle(mapContainerElement);
    surfaceLifecycle.reportCreated();
    // Wheel-over-popup does not zoom the map: Leaflet's DivOverlay calls DomEvent.disableScrollPropagation
    // on the popup content natively.

    const visibleTracks = this.getVisibleTracks(map);

    const updateZoomVariable = () => {
      updateZoomContainerState(mapContainerElement, map.getZoom());
    };
    map.on('zoom', () => perf.measure('zoom-state-update', updateZoomVariable, { zoom: map.getZoom() }, { slowOnly: true }));
    map.on('zoomend', () => perf.measure('zoomend-state-update', updateZoomVariable, { zoom: map.getZoom() }));
    perf.measure('initial-zoom-state', updateZoomVariable, { zoom: map.getZoom() });

    const stateKey = MapStateManager.getStateKey(runtime.source);

    if (stateKey) {
      map.on('moveend', () => {
        // Programmatic moves (fits, restores, resizes) must not overwrite the
        // user's viewport - only gestures and click-driven moves persist.
        if (cameraGuardFor(map).isProgrammaticMove()) return;
        const center = map.getCenter();
        MapStateManager.saveState(stateKey, {
          zoom: map.getZoom(),
          center: { lat: center.lat, lng: center.lng }
        });
      });
    }

    // Flag-based user-gesture detection: any camera move that starts outside
    // the programmatic guard is user-driven, including click-driven fits
    // (cluster zoom) that carry no originalEvent to sniff.
    const markGesture = () => {
      if (cameraGuardFor(map).isProgrammaticMove()) return;
      surfaceLifecycle.reportUserCameraGesture();
    };
    map.on('movestart', markGesture);
    map.on('zoomstart', markGesture);

    let disposed = false;
    const lifecycle: MapProviderLifecycle = {
      cleanup: () => component.unload(),
      hasActiveInstance: () => !disposed
    };

    component.register(() => {
      disposed = true;
      // Close any open popups before removing the map to prevent
      // "Cannot read properties of null (reading 'layerPointToContainerPoint')" error
      map.closePopup();
      map.remove();
      clearMapProviderState(mapContainerElement, LEAFLET_PROVIDER_STATE_ID);
      surfaceLifecycle.reportDestroyed();
    });

    component.load();

    // invalidateSize() fires move events; the guard keeps them from counting as
    // user camera activity or persisting viewport state.
    const resizeObserver = new ResizeObserver((entries) => {
      withProgrammaticCamera(map, () => map.invalidateSize());
      const rect = entries[entries.length - 1]?.contentRect;
      if (rect) surfaceLifecycle.reportSize(rect.width, rect.height);
    });
    resizeObserver.observe(mapContainerElement);
    component.register(() => resizeObserver.disconnect());

    // A custom tile URL carries no coverage metadata. The camera can sit at a zoom
    // or area the tileset has nothing for, leaving the map silently blank.
    let tileErrorEl: HTMLElement | undefined;
    const tileFailures = new TileFailureMonitor({
      onChange: (report) => {
        tileErrorEl?.remove();
        tileErrorEl = undefined;
        if (!report) return;
        tileErrorEl = renderMapSupplementalError(mapContainerElement, {
          icon: '⚠️',
          title: 'Map tiles failed to load',
          message: describeTileFailure(report),
          help: `Tile source: ${tileConfig.url}`,
          className: 'tile-load-error',
        });
      },
    });
    component.register(() => {
      tileFailures.dispose();
      tileErrorEl?.remove();
    });

    const tileLayer = perf.measure('add-tile-layer', () => new ObsidianTileLayer(tileConfig.url, {
      maxZoom: tileConfig.maxZoom,
      attribution: tileConfig.attribution,
      cacheProviderId: 'leaflet',
      onTileSuccess: () => tileFailures.recordSuccess(),
      onTileFailure: (url, error) => tileFailures.recordFailure(url, error) }).addTo(map));
    tileLayer.once('load', () => {
      logger.scope('MapSurface').debug('Leaflet visible tiles loaded', {
        source: runtime.source.path,
        engine: 'leaflet',
        engineVersion: leafletVersion,
        elapsedMs: Date.now() - loadStartTime,
        zoom: map.getZoom() });
    });

    const overlayPointFeatures = blockSettings.clusterGeoJsonOverlays
      ? [...extractOverlayPointFeaturesFromOverlays(runtime.overlays)].map(normalizeGeoJsonFeature)
      : [];

    const clusteringDecision = resolveClusteringDecision({
      placeCount: places.length,
      overlayPointCount: overlayPointFeatures.length,
      clusterThreshold: blockSettings.clusterThreshold,
      clusterGeoJsonOverlays: blockSettings.clusterGeoJsonOverlays });
    const { shouldCluster, unifiedClusteringActive } = clusteringDecision;

    if (isHeatmapLayer) {
      this.renderHeatmapLayer(map, places, blockSettings.heatmapColorScheme || 'heat');
      if (shouldFitInitialBounds) {
        withProgrammaticCamera(map, () => map.fitBounds(latLngBounds, { animate: false }));
      }
    } else {
      let clusterGroup: SimpleClusterGroup | null = null;

      if (shouldCluster) {
        const result = perf.measure('add-clustered-markers', () => this.addClusteredMarkers(geoJsonData, map, settings, places, blockSettings.clusterThreshold, overlayPointFeatures, perf), {
          places: places.length,
          overlayPointFeatures: overlayPointFeatures.length,
          clusterThreshold: blockSettings.clusterThreshold });
        clusterGroup = result.clusterGroup;
      } else {
        perf.measure('add-icon-markers', () => this.addLayerToMap(geoJsonData, map, settings), { places: places.length });
      }

      const mapState: LeafletMapState = {
        map,
        clusterGroup: clusterGroup!,
        currentPlaces: places,
        settings,
        blockSettings,
        runtime,
        geoJsonData,
        clusterThreshold: blockSettings.clusterThreshold,
        showClusters: shouldCluster,
        codeBlockOverlayLayers: [],
        geocodingMarkers: [],
        lifecycle
      };
      setMapProviderState<LeafletMapState>(mapContainerElement, LEAFLET_PROVIDER_STATE_ID, mapState);

      const visibility = settings.trackVisibility;

      const shouldShowTracks = !shouldCluster;

      if (shouldShowTracks && visibility && visibility.hasAnyVisibleTracks) {
        const placesToShow = visibility.placeStates.filter((s: PlaceTrackState) => s.showOnLoad);

        if (visibility.isSingleTrackView && placesToShow.length === 1) {
          const { place, style, outline, effectiveColorBy } = placesToShow[0];
          const colorBy = (effectiveColorBy as TrackColorBy | undefined) ?? settings.trackColorBy;
          const placeId = getPlaceId(place);
          const trackLayers: Layer[] = [];
          if (hasExplicitInitialView) {
            perf.measure('add-single-track', () => this.addTrackToMap(map, place, style, colorBy, settings.trackGradeWindow, trackLayers, outline, settings.trackSpeedWindow), { placeId });
          } else {
            perf.measure('add-single-track', () => this.addTrackToMap(map, place, style, colorBy, settings.trackGradeWindow, trackLayers, outline, settings.trackSpeedWindow), { placeId });
            const overlayBounds = place.overlay?.geojson ? this.calculateOverlayBounds(place.overlay.geojson) : null;
            if (overlayBounds) {
              withProgrammaticCamera(map, () => map.fitBounds(overlayBounds.bounds, { padding: [20, 20] }));
            }
          }
          visibleTracks.set(placeId, { place, settings, trackLayers, renderSignature: this.getTrackRenderSignature(place, settings.trackVisibility) });
        } else if (placesToShow.length > 0) {
          perf.measure('show-initial-tracks', () => this.showInitialTracks(map, placesToShow, settings, perf), { tracks: placesToShow.length });

          if (shouldFitInitialBounds) {
            withProgrammaticCamera(map, () => map.fitBounds(latLngBounds, { animate: false }));
          }
        }
      } else {
        if (shouldCluster) {
          logger.scope('Places').debug('[Leaflet] Clustering enabled - trackLayers will show when markers are unclustered');
        }
        if (shouldFitInitialBounds) {
          withProgrammaticCamera(map, () => map.fitBounds(latLngBounds, { animate: false }));
        }
      }
    }

    map.whenReady(() => {
      perf.mark('map-ready', { zoom: map.getZoom() });
      surfaceLifecycle.reportLoaded();
      withProgrammaticCamera(map, () => {
        map.invalidateSize();
        if (shouldFitInitialBounds) {
          map.fitBounds(latLngBounds, { animate: false });
        }
      });
      updateZoomVariable();
      logger.scope('MapSurface').debug('Leaflet map ready', {
        source: runtime.source.path,
        engine: 'leaflet',
        engineVersion: leafletVersion,
        elapsedMs: Date.now() - loadStartTime,
        zoom: map.getZoom(),
        sized: surfaceLifecycle.getState().sized });
    });

    await perf.measureAsync('process-overlays', () => this.processOverlays(map, mapContainerElement, request, places), {
      overlays: runtime.overlays.length });

    if (runtime.overlays.length > 0) {
      const geoJsonOverlays = runtime.overlays.filter(isGeoJSONOverlay);
      const imageOverlayEntries = runtime.overlays.filter(isImageOverlay);
      const overlayLayers: Layer[] = [];

      if (geoJsonOverlays.length > 0) {
        overlayLayers.push(...perf.measure('add-geojson-overlays', () => this.addGeoJSONOverlays(map, geoJsonOverlays, unifiedClusteringActive), { overlays: geoJsonOverlays.length }));
      }
      if (imageOverlayEntries.length > 0) {
        overlayLayers.push(...perf.measure('add-image-overlays', () => this.addImageOverlays(map, imageOverlayEntries), { overlays: imageOverlayEntries.length }));
      }
      const currentMapState = getMapProviderState<LeafletMapState>(mapContainerElement, LEAFLET_PROVIDER_STATE_ID);
      if (currentMapState) {
        currentMapState.codeBlockOverlayLayers = overlayLayers;
      }
    }

    perf.measure('setup-context-menu', () => this.setupContextMenu(map, mapContainerElement, runtime, places));
    this.wireSharedTrackPointListeners(map, mapContainerElement);

    if (blockSettings.debug) {
      const overlays = runtime.overlays;
      const geoJsonCount = overlays.filter(isGeoJSONOverlay).length;
      const imageCount = overlays.filter(isImageOverlay).length;

      this.addDebugDisplay(map, mapContainerElement, {
        places,
        overlayCount: geoJsonCount,
        imageOverlayCount: imageCount,
        providerName: 'leaflet',
        style: blockSettings.style,
        loadStartTime,
        prepareTimings: runtime.prepareTimings });
    }
    perf.mark('ready', {
      zoom: map.getZoom(),
      visibleTracks: visibleTracks.size,
      clustered: shouldCluster });
    let layerCount = 0;
    map.eachLayer(() => { layerCount += 1; });
    logger.scope('MapSurface').debug('Leaflet application render ready', {
      source: runtime.source.path,
      engine: 'leaflet',
      engineVersion: leafletVersion,
      elapsedMs: Date.now() - loadStartTime,
      zoom: map.getZoom(),
      layers: layerCount,
      visibleTracks: visibleTracks.size,
      clustered: shouldCluster });
  }

  private getFeatureMapPlace(feature: PlacesGeoJsonFeature): MapPlace | undefined {
    return parseMapPlaceProperty(feature.properties?.mapPlace);
  }

  private isPlaceMarkerLayer(layer: Layer): boolean {
    return typeof getLayerFeature(layer)?.properties?.mapPlace === 'string';
  }

  private isMarkerHidden(mapPlace?: MapPlace): boolean {
    return isStyleHidden(mapPlace?.iconStyle);
  }

  private buildMarkerHtml(feature: PlacesGeoJsonFeature, mapPlace: MapPlace | undefined, showLabels: boolean, includeContainerStyle = true): string {
    const iconStyle = mapPlace?.iconStyle;
    const dataAttrsStr = mapPlace?.dataAttributes
      ? MarkerStyleService.buildDataAttributesString(mapPlace.dataAttributes)
      : '';
    // Rotation composes with any user `transform` rather than replacing it, and
    // sits on the icon span, leaving Leaflet's own marker positioning untouched.
    const rotation = mapPlace?.iconRotation;
    const iconStyleCss = [
      iconStyle?.inlineCss || '',
      rotation === undefined ? '' : `transform: ${extractTransform(iconStyle?.inlineCss)} rotate(${rotation}deg); transform-origin: center`,
    ].filter(Boolean).join('; ');
    const labelStyle = mapPlace?.labelStyle;
    const labelStyleCss = labelStyle?.inlineCss || '';
    // A label hidden by `labelStyles` is not rendered at all, rather than
    // rendered invisibly: an invisible label still claimed a cell in the
    // collision grid and suppressed a neighbouring visible one.
    const labelHidden = isStyleHidden(labelStyle);
    const iconClasses = iconStyle?.classes?.join(' ') || '';
    const labelClasses = [
      labelStyle?.hasUserStyle ? 'places-marker-label-user-style' : '',
      labelStyle?.classes?.join(' ') || '',
    ].filter(Boolean).join(' ');
    const containerZoomClasses = getZoomRangeClassNames(iconStyle?.zoom).join(' ');
    // MarkerStyleService strips z-index out of inlineCss. Re-applying it here is
    // what makes an `iconStyles` z-index rule take effect.
    const containerStyle = [
      iconStyle?.zIndex !== undefined ? `--places-marker-z-index: ${iconStyle.zIndex}` : '',
    ].filter(Boolean).join('; ');
    const zIndexClass = iconStyle?.zIndex !== undefined ? 'places-marker-z-index-custom' : '';
    const placeIdAttr = mapPlace ? `data-place-id="${getPlaceId(mapPlace)}"` : '';
    const styleAttr = includeContainerStyle && containerStyle ? `style="${containerStyle}"` : '';

    // Opacity applies to the icon glyph only, matching MapLibre: dimming the
    // whole container would dim the label too, which `labelStyles` owns.
    const iconOpacityCss = iconStyle?.opacity !== undefined ? `opacity: ${iconStyle.opacity}` : '';
    const iconCss = [iconStyleCss, iconOpacityCss].filter(Boolean).join('; ');

    let html = `<div class="leaflet-marker-icon-container places-marker ${zIndexClass} ${containerZoomClasses}" ${dataAttrsStr} ${placeIdAttr} ${styleAttr}>
      <span class="leaflet-marker-icon-emoji places-marker-icon ${iconClasses}" style="${iconCss}">${scalarToString(feature.properties?.icon)}</span>`;

    if (showLabels && !labelHidden) {
      html += `<span class="leaflet-marker-icon-label leaflet-marker-icon-label-hidden places-marker-label ${labelClasses}" style="${labelStyleCss}">${scalarToString(feature.properties?.description)}</span>`;
    }

    html += `</div>`;
    return html;
  }


  private isZoomRangeVisible(map: LeafletMap, zoom?: ZoomRange): boolean {
    if (!zoom) return true;
    const currentZoom = map.getZoom();
    if (zoom.minZoom !== undefined && currentZoom < zoom.minZoom) return false;
    if (zoom.maxZoom !== undefined && currentZoom > zoom.maxZoom) return false;
    return true;
  }

  private addZoomManagedLayer(map: LeafletMap, layer: ZoomManagedLayer, zoom?: ZoomRange): ZoomManagedLayer {
    if (!zoom) {
      layer.addTo(map);
      return layer;
    }

    const update = () => {
      const shouldShow = this.isZoomRangeVisible(map, zoom);
      const isShown = map.hasLayer(layer);
      if (shouldShow && !isShown) {
        layer.addTo(map);
      } else if (!shouldShow && isShown) {
        map.removeLayer(layer);
      }
    };

    map.on('zoomend', update);
    layer.__placesZoomCleanup = () => map.off('zoomend', update);
    update();
    return layer;
  }

  private removeCodeBlockOverlayLayer(map: LeafletMap, layer: ZoomManagedLayer): void {
    layer.__placesZoomCleanup?.();
    layer.__placesZoomCleanup = undefined;
    if (map.hasLayer(layer)) map.removeLayer(layer);
  }

  private createMarkerDataList(geoJsonData: PlacesGeoJsonFeatureCollection, places: MapPlace[], showLabels: boolean, includeContainerStyle: boolean): MarkerData[] {
    const markerDataList: MarkerData[] = [];

    geoJsonData.features.forEach((feature, index) => {
      if (feature.geometry.type !== 'Point') return;

      const coords = (feature.geometry).coordinates;
      const latlng = new LatLng(coords[1], coords[0]);
      const place = places[index];
      const mapPlace = this.getFeatureMapPlace(feature);

      if (this.isMarkerHidden(mapPlace)) {
        return;
      }

      markerDataList.push({
        latlng,
        html: this.buildMarkerHtml(feature, mapPlace, showLabels, includeContainerStyle),
        place: mapPlace || place,
        feature
      });
    });

    return markerDataList;
  }

  private addLayerToMap(geoJsonData: PlacesGeoJsonFeatureCollection, map: LeafletMap, settings: CommonMapSettings): Marker[] {
    const icons = new Array<Marker>();
    const showLabels = settings.showLabels;

    new GeoJSON<Record<string, unknown>, GeoJson.Geometry>(geoJsonData, {
      pointToLayer: (feature: PlacesGeoJsonFeature, latlng: LatLng) => {
        const mapPlace = this.getFeatureMapPlace(feature);

        if (this.isMarkerHidden(mapPlace)) {
          return new Marker(latlng, { opacity: 0 });
        }

        const html = this.buildMarkerHtml(feature, mapPlace, showLabels);

        const containerSize = MarkerConstants.desktop.containerSize;
        const anchor = getIconAnchor('desktop');
        const popupAnchorOffset = getPopupAnchor('desktop');

        const marker = new Marker(latlng, {
          icon: new DivIcon({
            className: "leaflet-marker-icon",
            html: html,
            iconSize: [120, containerSize], // Wide container for labels, consistent height
            iconAnchor: anchor,
            popupAnchor: popupAnchorOffset
          })
        });
        icons.push(marker);
        return marker;
      },
      filter: (feature) => {
        return !this.isMarkerHidden(this.getFeatureMapPlace(feature));
      }
    })
      .bindPopup(this.bindPopup(map, settings).bind(this), {
        className: 'places-popup',
        closeOnClick: false,
        autoClose: false,
        trackResize: true,
        autoPan: false  // Prevent ResizeObserver error when map is removed
      })
      .addTo(map);

    if (showLabels) {
      this.setupLabelVisibility(map, icons);
    }

    return icons;
  }

  // Viewport-based: clusters show only when visible markers exceed the threshold.
  // overlayPointFeatures merge into the cluster group for unified clustering.
  private addClusteredMarkers(geoJsonData: PlacesGeoJsonFeatureCollection, map: LeafletMap, settings: CommonMapSettings, places: MapPlace[], clusterThreshold: number = 0, overlayPointFeatures: PlacesGeoJsonFeature[] = [], perf?: PerformanceMonitor): { markers: Marker[], clusterGroup: SimpleClusterGroup } {
    const markerDataList = this.createMarkerDataList(geoJsonData, places, settings.showLabels, true);

    overlayPointFeatures.forEach(feature => {
      if (feature.geometry.type !== 'Point') return;

      const coords = (feature.geometry).coordinates;
      const latlng = new LatLng(coords[1], coords[0]);
      const props = feature.properties || {};

      const html = `<div class="leaflet-marker-icon-container places-marker places-overlay-marker">
        <span class="leaflet-marker-icon-emoji places-marker-icon">📍</span>
      </div>`;

      const overlayPlace: MapPlace = {
        name: scalarToString(props.name) || scalarToString(props.title) || 'Point',
        latitude: coords[1],
        longitude: coords[0],
        icon: '📍'
      };

      markerDataList.push({
        latlng,
        html,
        place: overlayPlace,
        feature
      });
    });

    const popupBinder = this.bindPopup(map, settings).bind(this);
    const overlayPopupBinder = this.createOverlayPopup.bind(this);
    const clusterGroup = new SimpleClusterGroup(map, {
      clusterRadius: 50,
      bindPopup: (marker: Marker, _place: MapPlace, feature: PlacesGeoJsonFeature) => {
        (marker as FeatureLayer).feature = feature;

        if (feature.properties?._isOverlayPoint) {
          marker.bindPopup(() => overlayPopupBinder(map, feature), {
            className: 'places-popup',
            closeOnClick: false,
            autoClose: false,
            trackResize: true,
            autoPan: false  // Prevent ResizeObserver error when map is removed
          });
        } else {
          marker.bindPopup(popupBinder, {
            className: 'places-popup',
            closeOnClick: false,
            autoClose: false,
            trackResize: true,
            autoPan: false  // Prevent ResizeObserver error when map is removed
          });
        }
      }
    });
    clusterGroup.addMarkerData(markerDataList);

    let lastClusterState = true;

    const countVisibleMarkers = (): number => {
      const bounds = map.getBounds();
      let count = 0;
      markerDataList.forEach(data => {
        if (bounds.contains(data.latlng)) {
          count++;
        }
      });
      return count;
    };

    const updateLabels = () => {
      if (settings.showLabels && !clusterGroup.isShowingClusters()) {
        const visibleMarkers = clusterGroup.getVisibleMarkers();
        if (visibleMarkers.length > 0) {
          const markerInfos = visibleMarkers.map(buildLabelMarkerInfo);
          LabelVisibilityManager.updateLabelsOnce(
            markerInfos,
            LabelVisibilityManager.createLeafletPositionGetter(map),
            map.getZoom()
          );
        }
      }
    };

    const visibleTracks = this.getVisibleTracks(map);
    const visibility = settings.trackVisibility;
    const shouldShowByDefault = visibility?.shouldShowByDefault ?? false;
    const placesWithTracks = places.filter(p => hasTrackData(p) && !p.metadata?.frequency && !p.metadata?.boundsAnchor);
    // Built once - the place set is fixed for the life of this handler.
    const placeById = new Map<string, MapPlace>();
    for (const place of placesWithTracks) {
      placeById.set(getPlaceId(place), place);
    }

    const updateClusteringMode = () => {
      const visibleCount = this.measureIf(perf, 'cluster-count-visible', countVisibleMarkers, undefined, { slowOnly: true });
      const shouldShowClusters = shouldClusterCount(visibleCount, clusterThreshold);
      const wasShowingClusters = lastClusterState;

      if (shouldShowClusters !== lastClusterState) {
        lastClusterState = shouldShowClusters;
      }

      // Always update clusters/markers - zoom level affects cluster grouping
      this.measureIf(perf, 'cluster-update', () => clusterGroup.update(shouldShowClusters), { visibleCount, shouldShowClusters }, { slowOnly: true });

      if (shouldShowByDefault) {
        if (shouldShowClusters && wasShowingClusters !== shouldShowClusters) {
          for (const trackData of visibleTracks.values()) {
            for (const trackLayer of trackData.trackLayers) {
              trackLayer.remove();
            }
          }
          visibleTracks.clear();
        } else if (!shouldShowClusters) {
          const bounds = map.getBounds();
          const visiblePlaceIds = new Set<string>();

          markerDataList.forEach(data => {
            if (bounds.contains(data.latlng)) {
              const placeId = getPlaceId(data.place);
              visiblePlaceIds.add(placeId);
            }
          });

          const visiblePlacesWithTracks: MapPlace[] = [];
          for (const placeId of visiblePlaceIds) {
            const place = placeById.get(placeId);
            if (place && place.overlay && !visibleTracks.has(placeId)) {
              visiblePlacesWithTracks.push(place);
            }
          }

          for (const place of visiblePlacesWithTracks) {
            const placeId = getPlaceId(place);
            const trackLayers: Layer[] = [];
            const { style, outline } = getStyleForPlace(visibility, placeId);
            this.measureIf(perf, 'cluster-add-visible-trackLayer', () => this.addTrackToMap(map, place, style, settings.trackColorBy, settings.trackGradeWindow, trackLayers, outline, settings.trackSpeedWindow), { placeId }, { slowOnly: true });
            visibleTracks.set(placeId, { place, settings, trackLayers, renderSignature: this.getTrackRenderSignature(place, settings.trackVisibility) });
          }

          // Tracks whose marker is no longer visible come off the map.
          for (const [placeId, trackData] of Array.from(visibleTracks.entries())) {
            if (visiblePlaceIds.has(placeId)) continue;
            for (const trackLayer of trackData.trackLayers) {
              trackLayer.remove();
            }
            visibleTracks.delete(placeId);
          }
        }
      }

      if (!shouldShowClusters) {
        window.setTimeout(updateLabels, 50);
      }
    };

    const instrumentedUpdateClusteringMode = () => {
      this.measureIf(perf, 'cluster-update-total', updateClusteringMode, { zoom: map.getZoom(), visibleTracks: visibleTracks.size });
    };

    // Leaflet fires 'moveend' for pan AND zoom (a zoom moves the view), making it
    // the single trigger. A separate 'zoomend' listener would double the recompute
    // on every zoom, since zoomend always coincides with moveend.
    map.on('moveend', instrumentedUpdateClusteringMode);

    // Initial cluster display needs correct container dimensions. On mobile the
    // container may not be laid out yet when the map is created. Wait until it
    // has a size instead of guessing with timers.
    let initialUpdateDone = false;
    const doInitialUpdate = () => {
      if (initialUpdateDone) return;
      initialUpdateDone = true;
      instrumentedUpdateClusteringMode();
    };

    map.whenReady(() => {
      const container = map.getContainer();
      if (container.clientWidth > 0 && container.clientHeight > 0) {
        window.requestAnimationFrame(doInitialUpdate);
        return;
      }
      const sizeObserver = new ResizeObserver(() => {
        if (container.clientWidth > 0 && container.clientHeight > 0) {
          sizeObserver.disconnect();
          doInitialUpdate();
        }
      });
      sizeObserver.observe(container);
      map.on('unload', () => sizeObserver.disconnect());
    });

    return { markers: [], clusterGroup };
  }

  private setupLabelVisibility(map: LeafletMap, markers: Marker[]) {
    const markerInfos = markers.map(buildLabelMarkerInfo);

    LabelVisibilityManager.setupLabelVisibility(
      map,
      markerInfos,
      LabelVisibilityManager.createLeafletPositionGetter(map)
    );
  }

  bindPopup(map: LeafletMap, settings: CommonMapSettings): (layer: Layer) => HTMLElement {
    return (layer: Layer): HTMLElement => {
      const place = parseMapPlaceProperty(getLayerFeature(layer)?.properties?.mapPlace);

      const div = createDiv();

      if (!place) {
        return div;
      }

      if (place.metadata?.isWaypoint) {
        return buildWaypointPopupContent({
          place,
          units: this.units,
          onSourceLinkClick: (linkPath) => void this.app.workspace.openLinkText(linkPath, ''),
        });
      }

      // The shared builder decides the frequency wording ("Gps point" for a
      // single fix, header only above 1).
      const frequency = Number(scalarToString(place.metadata?.frequency)) || 0;
      const contributingFiles = parseContributingFiles(place.metadata?.contributingFiles);
      if (frequency > 0) {
        div.appendChild(this.createFrequencyPopup(frequency, contributingFiles));
      } else {
        const onPlaceAction = settings.onPlaceAction;
        const popupContent = buildPopupContent({
          icon: place.icon,
          name: place.name,
          subtitle: place.subtitle,
          isLink: !!place.filePath,
          linkPath: place.filePath,
          onLinkClick: place.filePath ? (linkPath) => void this.app.workspace.openLinkText(linkPath, '') : undefined,
          placeActions: place.actions,
          onPlaceAction: onPlaceAction ? (actionId, state) => onPlaceAction(place, actionId, state) : undefined,
          closePopup: () => map.closePopup(),
          debug: settings.popupDebug
            ? { fields: MarkerStyleService.styleMetadataEntries(place), filterRules: MarkerStyleService.explainPlaceMarkerFilter(place, settings.popupDebug.markerFilter) }
            : undefined
        });
        while (popupContent.firstChild) {
          div.appendChild(popupContent.firstChild);
        }
        div.className = popupContent.className;
        if (contributingFiles.length > 0) {
          div.appendChild(this.createFrequencyPopup(0, contributingFiles));
        }
      }

      if (place.overlay) {
        this.toggleTrack(map, place, settings);
      }

      if (place.filePath) {
        renderPopupContentAsync(this.app, place, div);
      }

      return div;
    };
  }

  private toggleTrack(map: LeafletMap, place: MapPlace, settings: CommonMapSettings): void {
    const visibleTracks = this.getVisibleTracks(map);
    const placeId = getPlaceId(place);

    if (visibleTracks.has(placeId)) {
      const trackData = visibleTracks.get(placeId)!;
      trackData.trackLayers.forEach(trackLayer => trackLayer.removeFrom(map));
      visibleTracks.delete(placeId);
    } else {
      const trackLayers: Layer[] = [];
      const { style, outline } = getStyleForPlace(settings.trackVisibility, placeId);
      this.addTrackToMap(map, place, style, settings.trackColorBy, settings.trackGradeWindow, trackLayers, outline, settings.trackSpeedWindow);
      visibleTracks.set(placeId, { place, settings, trackLayers, renderSignature: this.getTrackRenderSignature(place, settings.trackVisibility) });
    }
  }

  private showInitialTracks(map: LeafletMap, placeStates: PlaceTrackState[], settings: CommonMapSettings, perf?: PerformanceMonitor): void {
    const visibleTracks = this.getVisibleTracks(map);
    const statesWithTracks = placeStates.filter(s => hasTrackData(s.place));
    this.setupViewportTrackLoading(map, statesWithTracks.map(s => s.place), settings, visibleTracks, perf);
  }

  // Every trackLayer intersecting the viewport renders; offscreen trackLayers are skipped.
  private setupViewportTrackLoading(map: LeafletMap, places: MapPlace[], settings: CommonMapSettings, visibleTracks: Map<string, VisibleTrackEntry>, perf?: PerformanceMonitor): void {
    const trackData: Array<{
      place: MapPlace;
      bounds: LatLngBounds;
      rendered: boolean;
    }> = [];

    for (const place of places) {
      if (!place.overlay?.geojson) continue;
      try {
        const bounds = this.calculateOverlayBounds(place.overlay.geojson);
        if (!bounds) continue;

        trackData.push({
          place,
          bounds: bounds.bounds,
          rendered: false
        });
      } catch {
        // Skip invalid overlays
      }
    }

    const updateVisibleTracks = () => {
      const mapBounds = map.getBounds();

      const desiredIds = new Set(
        trackData
          .filter(data => mapBounds.intersects(data.bounds))
          .map(data => getPlaceId(data.place))
      );

      let addedCount = 0;
      for (const data of trackData.filter(item => desiredIds.has(getPlaceId(item.place)) && !item.rendered)) {
        const placeId = getPlaceId(data.place);
        const trackLayers: Layer[] = [];
        const { style, outline } = getStyleForPlace(settings.trackVisibility, placeId);
        this.measureIf(perf, 'viewport-add-trackLayer', () => this.addTrackToMap(map, data.place, style, settings.trackColorBy, settings.trackGradeWindow, trackLayers, outline, settings.trackSpeedWindow), { placeId }, { slowOnly: true });
        visibleTracks.set(placeId, { place: data.place, settings, trackLayers, renderSignature: this.getTrackRenderSignature(data.place, settings.trackVisibility) });
        data.rendered = true;
        addedCount++;
      }

      let removedCount = 0;
      for (const data of trackData.filter(item => item.rendered && !desiredIds.has(getPlaceId(item.place)))) {
          const placeId = getPlaceId(data.place);
          const trackEntry = visibleTracks.get(placeId);
          if (trackEntry) {
            trackEntry.trackLayers.forEach(p => p.removeFrom(map));
            visibleTracks.delete(placeId);
          }
          data.rendered = false;
          removedCount++;
      }

      const finalRendered = trackData.filter(d => d.rendered).length;
      if (addedCount > 0 || removedCount > 0) {
        logger.scope('Places').info(`[Leaflet] Viewport update: +${addedCount} -${removedCount} trackLayers (${finalRendered}/${trackData.length} visible)`);
      }
    };

    const instrumentedUpdateVisibleTracks = () => {
      this.measureIf(perf, 'viewport-trackLayer-update-total', updateVisibleTracks, { zoom: map.getZoom(), visibleTracks: visibleTracks.size });
    };

    instrumentedUpdateVisibleTracks();

    // 'moveend' covers pan and zoom (see the clustering setup); a 'zoomend'
    // listener would only double the recompute on every zoom.
    map.on('moveend', instrumentedUpdateVisibleTracks);
  }

  // Leaflet's GeoJSON layer keeps separate LineString features separate,
  // with no stray lines connecting track segments.
  private addTrackToMap(map: LeafletMap, place: MapPlace, style: 'solid' | 'dashed', coloringType?: TrackColorBy, gradeWindow?: MetricWindow, trackLayers?: Layer[], outlineOverride?: boolean, speedWindow?: MetricWindow): void {
    if (!place.overlay?.geojson) return;

    // Elevation and grade colour from stored elevations; speed and pace from
    // stored per-point times. A track missing what its mode needs draws plain.
    const isSpeedMode = coloringType === 'speed' || coloringType === 'pace';
    const trackTimes = place.overlay.track?.time;
    const useGradientColoring = isSpeedMode
      ? Boolean(trackTimes?.length)
      : (coloringType === 'elevation' || coloringType === 'grade') && Boolean(place.overlay.track?.elevation);

    if (useGradientColoring) {
      const trackData = extractTrackGeometry(place);
      if (trackData && (isSpeedMode ? trackTimes && trackTimes.length > 0 : trackData.elevations && trackData.elevations.length > 0)) {
        const renderData = TrackRenderer.createTrackRenderData(trackData.encodedPolyline, {
          coloringType,
          elevations: trackData.elevations,
          times: trackTimes,
          gradeWindow: gradeWindow ?? DEFAULT_GRADE_WINDOW,
          speedWindow,
          outlineOverride: outlineOverride ?? true // gradient lines get outline by default
        });

        if (renderData.type === 'colored' && renderData.segments.length > 0) {
          this.renderColoredTrack(map, renderData, place, trackLayers);
          this.addTrackWaypoints(map, place, trackLayers);
          return;
        }
      }
      // Fall through to single-color if gradient creation fails
    }

    const merged = mergeWithDefaults(place.overlay.style);

    // Style priority: frontmatter overlay style > resolver style (passed in) > merged defaults
    const effectiveStyle = place.overlay.style?.style ?? style ?? merged.style;
    const isDashed = effectiveStyle === 'dashed';
    // dashArray is authored as MapLibre line-width multipliers; Leaflet wants pixels.
    const dashArray = isDashed ? merged.dashArray.map(v => v * merged.weight).join(', ') : undefined;

    // Outline priority: resolver > frontmatter > false
    const showOutline = outlineOverride ?? place.overlay.style?.outline ?? false;

    const lineFilter = (feature: PlacesGeoJsonFeature | undefined) => {
      const type = feature?.geometry?.type;
      return type === 'LineString' || type === 'MultiLineString';
    };

    // Draw the outline first, behind the main line.
    if (showOutline) {
      const outlineLayer = new GeoJSON<Record<string, unknown>, GeoJson.Geometry>(place.overlay.geojson, {
        filter: lineFilter,
        style: () => ({
          color: merged.outlineColor,
          weight: merged.outlineWeight,
          opacity: merged.outlineOpacity,
          dashArray: dashArray
        })
      }).addTo(map);
      if (trackLayers) {
        outlineLayer.eachLayer((layer: Layer) => {
          if (layer instanceof Polyline) {
            trackLayers.push(layer);
          }
        });
      }
    }

    const mainLayer = new GeoJSON<Record<string, unknown>, GeoJson.Geometry>(place.overlay.geojson, {
      filter: lineFilter,
      style: () => ({
        color: merged.color,
        weight: merged.weight,
        opacity: merged.opacity,
        dashArray: dashArray
      })
    }).addTo(map);

    if (place.overlay.pathLabels?.length) {
      const labelCollection = { type: 'FeatureCollection', features: place.overlay.pathLabels } as typeof place.overlay.geojson;
      const labelLayer = new GeoJSON<Record<string, unknown>, GeoJson.Geometry>(labelCollection, {
        pointToLayer: (feature, latlng) => new Marker(latlng, {
          interactive: false,
          icon: new DivIcon({
            className: 'places-route-label-marker',
            html: `<span class="places-route-label">${escapeRouteLabelHtml(scalarToString(feature.properties?.route_label))}</span>`,
            iconSize: [80, 24],
            iconAnchor: [40, 12]
          })
        })
      }).addTo(map);
      trackLayers?.push(labelLayer);
    }

    if (trackLayers) {
      mainLayer.eachLayer((layer: Layer) => {
        if (layer instanceof Polyline) {
          trackLayers.push(layer);
        }
      });
    }

    mainLayer.eachLayer((layer: Layer) => {
      if (layer instanceof Polyline) {
        this.bindTrackPopup(layer, place, map);
      }
    });

    this.addTrackWaypoints(map, place, trackLayers);
  }

  // Waypoints (GPX `<wpt>` Point features) are pushed into the same `trackLayers` array that owns
  // the line: hiding or removing the track (via `visibleTracks`) tears them down with it.
  // Route-label points are excluded - they render through the path-label layer. Standalone
  // `overlays:` points are unaffected.
  private addTrackWaypoints(map: LeafletMap, place: MapPlace, trackLayers?: Layer[]): void {
    if (!place.overlay?.geojson) return;

    const waypointFeatures = getGeoJsonFeatures(place.overlay.geojson).filter(feature => {
      const type = feature.geometry?.type;
      return (type === 'Point' || type === 'MultiPoint') && !feature.properties?.route_label_point;
    });
    if (waypointFeatures.length === 0) return;

    const fillColor = mergeWithDefaults(place.overlay.style).color;
    const waypointCollection = { type: 'FeatureCollection', features: waypointFeatures } as typeof place.overlay.geojson;

    const waypointLayer = new GeoJSON<Record<string, unknown>, GeoJson.Geometry>(waypointCollection, {
      pointToLayer: (feature, latlng) => {
        const props = feature?.properties || {};
        return new CircleMarker(latlng, {
          radius: finiteNumberOr(props['circle-radius'], 5),
          fillColor: scalarToString(props['marker-color']) || fillColor,
          color: scalarToString(props.stroke) || '#ffffff',
          weight: finiteNumberOr(props['stroke-width'], 2),
          opacity: finiteNumberOr(props['stroke-opacity'], 1),
          fillOpacity: finiteNumberOr(props['fill-opacity'], 0.9)
        });
      },
      onEachFeature: (feature, layer) => {
        layer.bindPopup(() => buildOverlayPointPopupContent({
          properties: feature.properties || {},
          sourcePath: place.filePath,
          defaultName: 'Point',
          onSourceLinkClick: createSourceLinkClickHandler(place.filePath, (linkPath) => void this.app.workspace.openLinkText(linkPath, ''))
        }), { className: 'places-popup', autoPan: false });
      }
    }).addTo(map);

    trackLayers?.push(waypointLayer);
  }

  // Per-note dash override wins (empty string = solid); otherwise convert MapLibre-style dashArray
  // multipliers to Leaflet pixel values by multiplying by the default weight.
  private resolveDashArray(renderData: TrackRenderResult, place?: MapPlace): string | undefined {
    if (place?.trackDashArray !== undefined) {
      return place.trackDashArray || undefined;
    }
    return renderData.style.style === 'dashed'
      ? TRACK_STYLE_DEFAULTS.dashArray.map(v => v * TRACK_STYLE_DEFAULTS.weight).join(', ')
      : undefined;
  }

  private renderColoredTrack(map: LeafletMap, renderData: TrackRenderResult, place?: MapPlace, trackLayers?: Layer[]) {
    const dashArray = this.resolveDashArray(renderData, place);

    if (renderData.needsOutline) {
      const allCoords = renderData.trackCoords.map(coord => [coord.latitude, coord.longitude] as [number, number]);
      const continuousOutline = new Polyline(allCoords, {
        color: renderData.style.outlineColor,
        dashArray: dashArray,
        weight: renderData.style.outlineWeight,
        opacity: renderData.style.outlineOpacity
      }).addTo(map);

      if (place) {
        this.bindTrackPopup(continuousOutline, place, map);
      }

      if (trackLayers) {
        trackLayers.push(continuousOutline);
      }
    }

    renderData.segments.forEach(segment => {
      const leafletCoords = segment.coordinates.map(coord => [coord.latitude, coord.longitude] as [number, number]);

      const trackLayer = new Polyline(leafletCoords, {
        color: segment.color,
        dashArray: dashArray,
        weight: renderData.style.weight,
        opacity: renderData.style.opacity
      }).addTo(map);

      if (place) {
        this.bindTrackPopup(trackLayer, place, map);
      }

      if (trackLayers) {
        trackLayers.push(trackLayer);
      }
    });
  }

  // Follows the same contract as MapLibre's tracks: publish the selection, honour
  // `track.details: panel`, and open the place popup.
  private bindTrackPopup(trackLayer: Layer, place: MapPlace, map: LeafletMap) {
    const settings = this.settingsFor(map);
    trackLayer.on('click', (event: { latlng?: { lat: number; lng: number }; originalEvent?: MouseEvent }) => {
      if (!event.latlng) return;
      const coordinate = { latitude: event.latlng.lat, longitude: event.latlng.lng };
      dispatchMapTrackSelection(map.getContainer(), { place, coordinate, intent: 'preview', source: 'map-click' });

      if (settings.trackDetails === 'panel') {
        this.showTrackDetailsPanel(map, place, coordinate, settings);
        return;
      }

      const popup = trackLayer.bindPopup(this.buildTrackPopupContent(place, coordinate, settings, () => {
        (trackLayer as { getPopup?: () => { update?: () => void } }).getPopup?.()?.update?.();
      }));
      // Anchored at the click, not the line's centre: the popup describes the
      // point that was inspected.
      popup.openPopup(event.latlng);
    });
  }

  // The rendered block's settings for THIS map, from the provider state keyed by
  // its container. One processor instance serves every Leaflet map in the vault.
  // Instance fields would hand a click on one map the most recently rendered map's
  // `onPlaceAction`, inspection window, and details mode.
  private settingsFor(map: LeafletMap): CommonMapSettings {
    return getMapProviderState<LeafletMapState>(map.getContainer(), LEAFLET_PROVIDER_STATE_ID)?.settings ?? ({} as CommonMapSettings);
  }

  // The docked details panel for this map, created on first use and disposed with it.
  private showTrackDetailsPanel(map: LeafletMap, place: MapPlace, coordinate: { latitude: number; longitude: number }, settings: CommonMapSettings): void {
    map.closePopup();
    let panel = this.trackDetailsPanels.get(map);
    if (!panel) {
      panel = new TrackDetailsPanel({
        container: map.getContainer(),
        openLink: (linkPath) => void this.app.workspace.openLinkText(linkPath, ''),
        // The close button disposes the panel internally; dropping this entry is
        // what lets the next track click build a fresh one.
        onDispose: () => this.trackDetailsPanels.delete(map),
      });
      this.trackDetailsPanels.set(map, panel);
      map.on('unload', () => this.trackDetailsPanels.get(map)?.dispose());
    }
    panel.show(place, coordinate, settings.inspectTrack);
  }

  private buildTrackPopupContent(place: MapPlace, coordinate: { latitude: number; longitude: number }, settings: CommonMapSettings, onRendered: () => void): HTMLElement {
    const onPlaceAction = settings.onPlaceAction;
    const content = buildPopupContent({
      icon: place.icon,
      name: place.name,
      subtitle: place.subtitle,
      isLink: !!place.filePath,
      linkPath: place.filePath,
      onLinkClick: place.filePath ? (linkPath) => void this.app.workspace.openLinkText(linkPath, '') : undefined,
      placeActions: place.actions,
      onPlaceAction: onPlaceAction ? (actionId, state) => onPlaceAction(place, actionId, state) : undefined,
    });

    // Heatmap tracks carry a frequency and the routes that contributed it; the
    // shared builder decides the wording ("Gps point" for a single fix).
    const frequency = Number(scalarToString(place.metadata?.frequency)) || 0;
    const contributingFiles = parseContributingFiles(place.metadata?.contributingFiles);
    if (frequency > 0 || contributingFiles.length > 0) {
      content.appendChild(this.createFrequencyPopup(frequency, contributingFiles));
    }

    if (settings.inspectTrack) {
      appendTrackInspectionSection({ host: content, place, coordinate, inspectTrack: settings.inspectTrack, onRendered });
    }
    return content;
  }

  private getTileConfig(style?: string): { url: string; attribution: string; maxZoom: number } {
    const requestedStyle = style;
    const selectedStyle = Platform.isMobile && requestedStyle === "openstreetmap"
      ? undefined
      : requestedStyle;

    return getTileLayerConfig(
      selectedStyle,
      this.extensionSettings.tileLayerUrl,
      this.extensionSettings.tileLayerAttribution
    );
  }

  private addImageOverlays(map: LeafletMap, overlays: Array<{ url: string; bounds?: { swLat: number; swLng: number; neLat: number; neLng: number }; opacity?: number; source?: string; zoom?: ZoomRange }>): Layer[] {
    const layers: Layer[] = [];
    overlays.forEach((overlay, index) => {
      try {
        if (!overlay.bounds) {
          logger.scope('Places').warn(`[Leaflet] Skipping image overlay ${index + 1} - no bounds specified`);
          return;
        }
        const bounds = new LatLngBounds(
          [overlay.bounds.swLat, overlay.bounds.swLng],
          [overlay.bounds.neLat, overlay.bounds.neLng]
        );

        const layer = new ImageOverlay(overlay.url, bounds, {
          opacity: overlay.opacity ?? 1.0,
          interactive: false,
          // Leaflet 2 can keep large overlay decoding off the rendering path.
          decoding: 'async'
        });
        layers.push(this.addZoomManagedLayer(map, layer, overlay.zoom));

        logger.scope('Places').debug(`[Leaflet] Added image overlay ${index + 1}/${overlays.length} from ${overlay.source || overlay.url}`);
      } catch (error) {
        logger.scope('Places').warn(`[Leaflet] Failed to add image overlay ${index + 1}:`, error);
      }
    });
    return layers;
  }

  // When skipPointFeatures is true, point features are handled separately by unified clustering.
  private addGeoJSONOverlays(map: LeafletMap, overlays: Array<{ geojson: GeoJson.GeoJSON; source: string; zoom?: ZoomRange }>, skipPointFeatures: boolean = false): Layer[] {
    const layers: Layer[] = [];
    overlays.forEach(overlay => {
      try {

        const hitAreaLayer = new GeoJSON<Record<string, unknown>, GeoJson.Geometry>(overlay.geojson, {
          style: (feature) => {
            // Transparent wide line for hit detection.
            if (feature?.geometry?.type === 'LineString' || feature?.geometry?.type === 'MultiLineString') {
              return {
                color: 'transparent',
                weight: 15,
                opacity: 0
              };
            }
            return { opacity: 0, fillOpacity: 0 };
          },
          pointToLayer: () => {
            // Don't create anything for points in hit area layer
            return new CircleMarker([0, 0], { opacity: 0, fillOpacity: 0, radius: 0 });
          },
          filter: (feature) => {
            return feature?.geometry?.type === 'LineString' || feature?.geometry?.type === 'MultiLineString';
          },
          onEachFeature: (feature, layer) => {
            rememberRouteOverlayMatch(layer, feature, overlay.geojson);
            layer.on('click', (e) => {
              DomEvent.stopPropagation(e);
              this.showGeoJsonFeaturePopup(map, feature, layer, overlay.source);
            });
          }
        });
        layers.push(this.addZoomManagedLayer(map, hitAreaLayer, overlay.zoom));

        const geoJsonLayer = new GeoJSON<Record<string, unknown>, GeoJson.Geometry>(overlay.geojson, {
          style: (feature) => {
            const props = feature?.properties || {};
            const weight = finiteNumberOr(props['stroke-width'], 2);
            let dashArray: string | undefined;
            if (props['stroke-dasharray'] !== undefined) {
              // An empty string means solid.
              dashArray = scalarToString(props['stroke-dasharray']) || undefined;
            } else {
              // Default pattern, its multipliers converted to pixels.
              dashArray = TRACK_STYLE_DEFAULTS.dashArray.map(v => v * weight).join(', ');
            }
            return {
              color: scalarToString(props.stroke) || TRACK_STYLE_DEFAULTS.color,
              fillColor: scalarToString(props.fill) || TRACK_STYLE_DEFAULTS.color,
              weight,
              opacity: finiteNumberOr(props['stroke-opacity'], 1),
              fillOpacity: finiteNumberOr(props['fill-opacity'], 0.3),
              dashArray
            };
          },
          filter: (feature) => {
            if (skipPointFeatures && (feature?.geometry?.type === 'Point' || feature?.geometry?.type === 'MultiPoint')) {
              return false;
            }
            return true;
          },
          pointToLayer: (feature, latlng) => {
            const props = feature?.properties || {};
            if (props.route_label_point && props.route_label) {
              return new Marker(latlng, {
                interactive: false,
                icon: new DivIcon({
                  className: 'places-route-label-marker',
                  html: `<span class="places-route-label">${escapeRouteLabelHtml(scalarToString(props.route_label))}</span>`,
                  iconSize: [80, 24],
                  iconAnchor: [40, 12]
                })
              });
            }
            if (props.route_endpoint_label) {
              return new Marker(latlng, {
                interactive: true,
                icon: new DivIcon({
                  className: 'places-route-label-marker',
                  html: `<span class="places-route-label">${escapeRouteLabelHtml(scalarToString(props.route_endpoint_label))}</span>`,
                  iconSize: [140, 24],
                  iconAnchor: [70, -6]
                })
              });
            }
            const radius = finiteNumberOr(props['circle-radius'], 5);
            return new CircleMarker(latlng, {
              radius,
              fillColor: scalarToString(props['marker-color']) || TRACK_STYLE_DEFAULTS.color,
              color: scalarToString(props.stroke) || '#ffffff',
              weight: finiteNumberOr(props['stroke-width'], 1),
              opacity: finiteNumberOr(props['stroke-opacity'], 1),
              fillOpacity: finiteNumberOr(props['fill-opacity'], 0.7)
            });
          },
          onEachFeature: (feature, layer) => {
            rememberRouteOverlayMatch(layer, feature, overlay.geojson);
            const geomType = feature?.geometry?.type;
            if (geomType !== 'LineString' && geomType !== 'MultiLineString') {
              layer.on('click', (e) => {
                DomEvent.stopPropagation(e);
                this.showGeoJsonFeaturePopup(map, feature, layer, overlay.source);
              });
            }
          }
        });

        layers.push(this.addZoomManagedLayer(map, geoJsonLayer, overlay.zoom));
        logger.scope('Places').debug(`[Leaflet] Added GeoJSON overlay from ${overlay.source}`);
      } catch (error) {
        logger.scope('Places').warn(`[Leaflet] Failed to add GeoJSON overlay from ${overlay.source}:`, error);
      }
    });
    return layers;
  }

  private syncCodeBlockOverlays(mapState: LeafletMapState, request: MapRenderRequest): void {
    if (this.applyImageOpacityOnlyUpdate(mapState, request)) {
      mapState.blockSettings = request.config;
      mapState.runtime = request.runtime;
      return;
    }

    for (const layer of mapState.codeBlockOverlayLayers) {
      this.removeCodeBlockOverlayLayer(mapState.map, layer);
    }

    const geoJsonOverlays = request.runtime.overlays.filter(isGeoJSONOverlay);
    const imageOverlayEntries = request.runtime.overlays.filter(isImageOverlay);
    const overlayLayers: Layer[] = [];
    if (geoJsonOverlays.length > 0) {
      overlayLayers.push(...this.addGeoJSONOverlays(mapState.map, geoJsonOverlays, request.runtime.unifiedClusteringActive));
    }
    if (imageOverlayEntries.length > 0) {
      overlayLayers.push(...this.addImageOverlays(mapState.map, imageOverlayEntries));
    }
    mapState.codeBlockOverlayLayers = overlayLayers;
    mapState.blockSettings = request.config;
    mapState.runtime = request.runtime;
  }

  // Removing and recreating ImageOverlay layers produces a conspicuous blank
  // frame while the replacement image is attached.
  private applyImageOpacityOnlyUpdate(mapState: LeafletMapState, request: MapRenderRequest): boolean {
    const previousOverlays = mapState.runtime.overlays;
    const nextOverlays = request.runtime.overlays;
    if (previousOverlays.length !== nextOverlays.length || previousOverlays.length === 0) return false;

    const previousImages = previousOverlays.filter(isImageOverlay);
    const nextImages = nextOverlays.filter(isImageOverlay);
    if (previousImages.length !== nextImages.length || previousImages.length === 0) return false;

    for (let index = 0; index < previousOverlays.length; index++) {
      const previous = previousOverlays[index];
      const next = nextOverlays[index];
      if (!isImageOverlay(previous) || !isImageOverlay(next)) {
        if (JSON.stringify(previous) !== JSON.stringify(next)) return false;
        continue;
      }
      // Compare everything except style; opacity is handled separately below,
      // and JSON.stringify drops the undefined key from both sides.
      const previousIdentity = { ...previous, style: undefined };
      const nextIdentity = { ...next, style: undefined };
      if (JSON.stringify(previousIdentity) !== JSON.stringify(nextIdentity)) return false;
    }

    const geoJsonLayerCount = previousOverlays.filter(isGeoJSONOverlay).length;
    for (let index = 0; index < nextImages.length; index++) {
      const layer = mapState.codeBlockOverlayLayers[geoJsonLayerCount + index];
      if (!(layer instanceof ImageOverlay)) return false;
      layer.setOpacity(nextImages[index].style?.opacity ?? 1);
    }
    return true;
  }

  private showGeoJsonFeaturePopup(_map: LeafletMap, feature: PlacesGeoJsonFeature, layer: Layer, sourcePath?: string): void {
    const properties = feature.properties || {};
    const geometryType = feature.geometry?.type || 'Feature';
    const popupDiv = buildGeoJsonFeaturePopupContent({
      properties,
      geometryType,
      sourcePath,
      // The builder resolves which link this feature points at - a route
      // endpoint names its own waypoint note, not the overlay's source - and
      // http(s) sources open in a browser. Ignoring the resolved path and
      // reopening `sourcePath` would send both cases to the wrong place.
      onSourceLinkClick: createSourceLinkClickHandler(sourcePath, (linkPath) => void this.app.workspace.openLinkText(linkPath, ''))
    });

    layer.bindPopup(popupDiv).openPopup();
  }

  // Follow chart clicks and inspection requests, as the vector engines do.
  private wireSharedTrackPointListeners(map: LeafletMap, container: HTMLElement): void {
    const applySharedTrackPoint = (event: Event): void => {
      const detail = (event as CustomEvent<{ trackPath?: string; latitude?: number; longitude?: number }>).detail;
      if (!detail || detail.latitude === undefined || detail.longitude === undefined) return;

      const places = this.getCurrentPlaces(container) ?? [];
      const exactPlace = places.find(candidate => candidate.filePath === detail.trackPath);
      // A named track that is not on this map is not this map's to answer for.
      if (detail.trackPath && !exactPlace) return;
      const place = exactPlace ?? places.find(candidate => hasTrackData(candidate));
      if (!place) return;

      const settings = this.settingsFor(map);
      const coordinate = { latitude: detail.latitude, longitude: detail.longitude };
      if (settings.trackDetails === 'panel') {
        this.showTrackDetailsPanel(map, place, coordinate, settings);
        return;
      }
      const popup = new Popup().setLatLng([coordinate.latitude, coordinate.longitude]);
      popup.setContent(this.buildTrackPopupContent(place, coordinate, settings, () => popup.update()));
      popup.openOn(map);
    };

    const ownerDocument = container.ownerDocument;
    container.addEventListener(TRACK_INSPECTION_REQUEST_EVENT, applySharedTrackPoint);
    ownerDocument.addEventListener(TRACK_POINT_SELECT_EVENT, applySharedTrackPoint);
    map.on('unload', () => {
      container.removeEventListener(TRACK_INSPECTION_REQUEST_EVENT, applySharedTrackPoint);
      ownerDocument.removeEventListener(TRACK_POINT_SELECT_EVENT, applySharedTrackPoint);
    });
  }

  private setupContextMenu(map: LeafletMap, mapContainerElement: HTMLElement, runtime: MapRenderRequest['runtime'], places: MapPlace[]): void {
    const contextMenu = new MapContextMenu({
      placeNoteHost: runtime.placeNoteHost,
      reverseGeocodeHost: runtime.reverseGeocodeHost,
      customMenuItems: (coordinate) => {
        const items = runtime.contextMenuActions.map((action) => ({ text: action.text, icon: action.icon, onClick: () => action.onClick(coordinate) }));

        // Export actions, matching the vector engines: the note itself is
        // written by the host; only finding the feature differs per engine.
        const placeNoteHost = runtime.placeNoteHost;
        const match = lastRightClickedRouteOverlay;
        if (match && placeNoteHost) {
          items.push(match.kind === 'directions'
            ? {
              text: 'Export directions to new note',
              icon: '↗',
              onClick: async () => {
                await placeNoteHost.createNote(await prepareDirectionsOverlayNote(match.feature, runtime.source.path));
              } }
            : {
              text: 'Export isochrone to new note',
              icon: '↗',
              onClick: async () => {
                await placeNoteHost.createNote(prepareIsochroneOverlayNote(match.collection, runtime.source.path));
              } });
        }

        if (!this.developerMode) return items;

        return [...items, {
          text: 'Run marker zoom test',
          icon: '🔎',
          onClick: async () => {
            await runMarkerZoomTest(
              mapContainerElement,
              this.getCurrentPlaces(mapContainerElement) ?? places,
              (place, zoom) => {
                withProgrammaticCamera(map, () => map.setView([place.latitude, place.longitude], zoom, { animate: false }));
              },
              (markerPlaces) => {
                const bounds = map.getBounds();
                return markerPlaces.filter((place) => bounds.contains([place.latitude, place.longitude]));
              },
              { providerName: 'Leaflet' }
            );
          }
        }];
      } });

    // Leaflet raises 'contextmenu' on both a right-click and a touch long-press, with the map
    // coordinate attached - no DOM drag-detection, unproject, or manual long-press timer needed.
    map.on('contextmenu', (event: LeafletMouseEvent) => {
      event.originalEvent.preventDefault();
      // Leaflet propagates a layer's contextmenu to the map, naming the layer in
      // `propagatedFrom`; that is how the menu learns what was right-clicked.
      // Read per event: a click on empty map cannot inherit the last one.
      lastRightClickedRouteOverlay = event.propagatedFrom ? routeOverlayMatchByLayer.get(event.propagatedFrom as Layer) : undefined;
      const coordinate = { latitude: event.latlng.lat, longitude: event.latlng.lng };
      contextMenu.open(coordinate, event.originalEvent.clientX, event.originalEvent.clientY, event.originalEvent);
      lastRightClickedRouteOverlay = undefined;
    });

    // Close the menu with its map (Leaflet fires 'unload' from map.remove()).
    map.on('unload', () => contextMenu.cleanup());
  }

  getMapControlHandle(container: HTMLElement): MapControlHandle | null {
    const mapState = getMapProviderState<LeafletMapState>(container, LEAFLET_PROVIDER_STATE_ID);
    if (!mapState) return null;
    const { map } = mapState;

    return {
      getBounds: () => {
        const bounds = map.getBounds();
        return new PlacesBoundingBox(bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast());
      },
      centerOnPlace: (place: MapPlace) => {
        map.flyTo([place.latitude, place.longitude], Math.max(map.getZoom(), 14), {
          duration: 0.5 });
      },
      highlightPlace: (place: MapPlace) => {
        this.highlightPlace(map, container, place);
      },
      clearHighlight: () => {
        this.clearPlaceHighlight(map, container);
      },
      setGeocodingSearchMarkers: (places: MapPlace[]) => {
        this.setGeocodingSearchMarkers(places, container);
      } };
  }

  private highlightPlace(map: LeafletMap, container: HTMLElement, place: MapPlace): void {
    container.addClass('places-focus-mode');

    const placeId = getPlaceId(place);
    const applyFocusedClass = () => {
      container.querySelectorAll('.places-marker-focused').forEach((el) => el.removeClass('places-marker-focused'));
      const target = container.querySelector<HTMLElement>(`.places-marker[data-place-id="${CSS.escape(placeId)}"]`);
      target?.addClass('places-marker-focused');
      target?.closest('.leaflet-marker-icon')?.addClass('places-marker-focused');
    };
    applyFocusedClass();
    map.once('moveend', applyFocusedClass);

    this.openPopupForPlace(map, container, place);
  }

  private clearPlaceHighlight(map: LeafletMap, container: HTMLElement): void {
    container.removeClass('places-focus-mode');
    container.querySelectorAll('.places-marker-focused').forEach((el) => el.removeClass('places-marker-focused'));
    map.closePopup();
  }

  private openPopupForPlace(map: LeafletMap, _mapContainerElement: HTMLElement, place: MapPlace): void {
    map.closePopup();

    const popupContent = buildPopupContent({
      icon: place.icon,
      name: place.name,
      isLink: !!place.filePath,
      linkPath: place.filePath,
      onLinkClick: place.filePath ? (linkPath) => void this.app.workspace.openLinkText(linkPath, '') : undefined
    });

    new Popup({
      offset: [0, -15],
      className: 'places-popup',
      closeOnClick: true,
      trackResize: true
    })
      .setLatLng([place.latitude, place.longitude])
      .setContent(popupContent)
      .openOn(map);
  }

  private renderHeatmapLayer(map: LeafletMap, places: MapPlace[], colorScheme: string): void {
    logger.scope('Places').debug('[Leaflet] Rendering heatmap layer with', places.length, 'points');

    let minWeight = Infinity;
    let maxWeight = -Infinity;

    for (const place of places) {
      const weight = (place.metadata?.heatmapWeight as number) || 1;
      minWeight = Math.min(minWeight, weight);
      maxWeight = Math.max(maxWeight, weight);
    }

    logger.scope('Places').debug(`[Leaflet] Heatmap weight range: ${minWeight} to ${maxWeight}`);

    const getColor = (normalizedWeight: number): string => {
      return ColorSchemes.getHeatmapColor(normalizedWeight, colorScheme);
    };

    // One canvas renderer for all points: thousands of SVG CircleMarkers make
    // pan/zoom crawl, a single canvas does not.
    const renderer = new Canvas();
    const heatmapLayer = new LayerGroup();

    places.forEach(place => {
      const weight = (place.metadata?.heatmapWeight as number) || 1;
      const normalizedWeight = maxWeight > minWeight
        ? (weight - minWeight) / (maxWeight - minWeight)
        : 1.0;

      const radius = 4 + (normalizedWeight * 11);
      const opacity = 0.4 + (normalizedWeight * 0.4);

      const circle = new CircleMarker([place.latitude, place.longitude], {
        renderer,
        radius: radius,
        fillColor: getColor(normalizedWeight),
        color: '#fff',
        weight: 1,
        opacity: 0.8,
        fillOpacity: opacity
      });

      // Built lazily: at most one popup is ever open.
      circle.bindPopup(() => {
        const metadataFrequency = place.metadata?.frequency;
        const frequency = typeof metadataFrequency === 'number' ? metadataFrequency : weight;
        return this.createFrequencyPopup(frequency, parseContributingFiles(place.metadata?.contributingFiles));
      });

      heatmapLayer.addLayer(circle);
    });

    heatmapLayer.addTo(map);

    logger.scope('Places').debug('[Leaflet] Heatmap layer rendered successfully');
  }

  // Enabled with `debug: true` in the code block.
  private addDebugDisplay(map: LeafletMap, container: HTMLElement, debugData: {
    places: MapPlace[];
    overlayCount: number;
    imageOverlayCount: number;
    providerName: string;
    style?: string;
    loadStartTime: number;
    prepareTimings?: MapPrepareTimings;
  }): void {
    addSharedDebugOverlay(container, debugData, createLeafletDebugOverlayAdapter(map));
    logger.scope('Places').debug(`[Leaflet DEBUG] Debug overlay enabled`);
  }

  // Leaflet handles gestures in JavaScript and needs touch-action: none.
  // pan-x pan-y pinch-zoom hands gestures to the browser and breaks that handling.
  //
  // Scroll-into-view prevention on focus is not implemented for Leaflet
  // due to conflicts with Leaflet's internal event handling. This is a known
  // limitation - clicking a partially visible Leaflet map may scroll it into view.
  protected setupMapTouchHandlers(element: HTMLElement): void {
    element.addClass('places-leaflet-touch-target');
  }

  getCurrentPlaces(container: HTMLElement): MapPlace[] | null {
    const mapState = getMapProviderState<LeafletMapState>(container, LEAFLET_PROVIDER_STATE_ID);
    if (!mapState) return null;
    return mapState.currentPlaces.length > 0 ? mapState.currentPlaces : null;
  }

  getIncrementalUpdateCapabilities(): Readonly<MapIncrementalUpdateCapabilities> {
    return {
      places: true,
      overlays: true,
      styles: false,
      tools: false,
      clustering: false,
      terrain: false };
  }

  updateMapData(container: HTMLElement, newPlaces: MapPlace[], request: MapRenderRequest, context?: MapDataUpdateContext): Promise<MapDataUpdateResult> {
    const blockSettings = request.config;
    const runtime = request.runtime;
    const perf = createPerformanceMonitor('leaflet-update', {
      provider: 'leaflet',
      source: runtime.source.path,
      places: newPlaces.length,
      overlays: runtime.overlays.length,
      trackDefaultVisibility: blockSettings.trackDefaultVisibility }, { enabled: this.developerMode });
    const ineligibleReason = this.getMapDataUpdateIneligibleReason(blockSettings);
    if (ineligibleReason) {
      logger.scope('Places').debug(`[Places Leaflet Incremental] ${ineligibleReason} - full refresh needed`);
      perf.mark('ineligible', { reason: ineligibleReason });
      return Promise.resolve({ updated: false, status: 'requires-rebuild', reason: ineligibleReason });
    }

    const mapState = getMapProviderState<LeafletMapState>(container, LEAFLET_PROVIDER_STATE_ID);
    if (!mapState) {
      logger.scope('Places').debug('[Places Leaflet Incremental] No map state found - full refresh needed');
      perf.mark('ineligible', { reason: 'no map state found' });
      return Promise.resolve({ updated: false, status: 'requires-rebuild', reason: 'no map state found' });
    }

    const { map, clusterGroup, currentPlaces, settings, clusterThreshold, showClusters } = mapState;
    if (!map || !map.getContainer()) {
      logger.scope('Places').debug('[Places Leaflet Incremental] Map no longer valid - full refresh needed');
      perf.mark('ineligible', { reason: 'map no longer valid' });
      return Promise.resolve({ updated: false, status: 'requires-rebuild', reason: 'map no longer valid' });
    }

    if (hasOverlayRenderableChanges(context?.planDiff)) {
      perf.measure('sync-codeblock-overlays', () => this.syncCodeBlockOverlays(mapState, request));
    }
    if (hasTrackRenderableChanges(context?.planDiff)) {
      perf.measure('sync-visible-tracks', () => this.syncVisibleTrackOverlays(map, settings, this.extractCommonSettings(blockSettings, runtime)), {
        visibleTracks: this.getVisibleTracks(map).size });
    }

    const currentPlaceIds = new Set(currentPlaces.map(p => getPlaceId(p)));
    const newPlaceIds = new Set(newPlaces.map(p => getPlaceId(p)));

    let additions = 0;
    let removals = 0;

    for (const placeId of currentPlaceIds) {
      if (!newPlaceIds.has(placeId)) removals++;
    }
    for (const placeId of newPlaceIds) {
      if (!currentPlaceIds.has(placeId)) additions++;
    }

    logger.scope('Places').debug(`[Places Leaflet Incremental] Updating markers: ${removals} to remove, ${additions} to add`);

    if (showClusters && clusterGroup) {
      const { featureCollection: geoJsonData } = convertPlacesToFeatureCollection(newPlaces);
      const markerDataList = this.buildMarkerDataList(geoJsonData, newPlaces, settings);

      const visibleCount = markerDataList.length;
      const shouldShowClusters = shouldClusterCount(visibleCount, clusterThreshold);
      perf.measure('cluster-update-marker-data', () => clusterGroup.updateMarkerData(markerDataList, shouldShowClusters), {
        markerData: markerDataList.length,
        shouldShowClusters });
    } else {
      perf.measure('remove-existing-markers', () => map.eachLayer((layer: Layer) => {
        if (this.isPlaceMarkerLayer(layer)) {
          map.removeLayer(layer);
        }
      }));

      const { featureCollection: geoJsonData } = convertPlacesToFeatureCollection(newPlaces);
      perf.measure('rebuild-markers', () => this.addLayerToMap(geoJsonData, map, settings), { places: newPlaces.length });
    }

    mapState.currentPlaces = newPlaces;
    mapState.settings = {
      ...settings,
      trackVisibility: runtime.trackVisibility,
      onPlaceAction: runtime.onPlaceAction };
    mapState.blockSettings = blockSettings;
    mapState.runtime = runtime;

    perf.mark('complete', {
      markers: newPlaces.length,
      visibleTracks: this.getVisibleTracks(map).size });
    return Promise.resolve({ updated: true });
  }

  applyCamera(container: HTMLElement, camera: MapCameraIntent, request: MapRenderRequest): MapCameraApplyResult {
    const mapState = getMapProviderState<LeafletMapState>(container, LEAFLET_PROVIDER_STATE_ID);
    const map = mapState?.map;
    if (!map || !map.getContainer()) return { applied: false, reason: 'no map instance found' };

    switch (camera.kind) {
      case 'fit-data': {
        const bounds = new PlacesBoundingBox();
        for (const place of mapState.currentPlaces) {
          // Frequency places and bounds anchors are non-interactive synthetics
          if (place.metadata?.frequency !== undefined || place.metadata?.boundsAnchor === true) continue;
          bounds.update(place.latitude, place.longitude);
        }
        this.extendBoundsWithOverlays(bounds, request.runtime.overlays, request.config.debug);
        if (!bounds.isValid()) return { applied: false, reason: 'no valid data bounds' };
        const [[minLat, minLng], [maxLat, maxLng]] = bounds.getConventionalLatLngBounds();
        withProgrammaticCamera(map, () => map.fitBounds(new LatLngBounds([minLat, minLng], [maxLat, maxLng]), {
          padding: camera.padding !== undefined ? [camera.padding, camera.padding] : [20, 20],
          maxZoom: camera.maxZoom,
          animate: false }));
        return { applied: true };
      }
      case 'explicit': {
        const currentCenter = map.getCenter();
        // Intent center is [lng, lat] (settings convention); Leaflet wants [lat, lng]
        const center: [number, number] = camera.center ? [camera.center[1], camera.center[0]] : [currentCenter.lat, currentCenter.lng];
        withProgrammaticCamera(map, () => map.setView(center, camera.zoom ?? map.getZoom(), { animate: false }));
        return { applied: true };
      }
      case 'preserve': {
        return { applied: true };
      }
    }
  }

  private syncVisibleTrackOverlays(map: LeafletMap, _currentSettings: CommonMapSettings, nextSettings: CommonMapSettings): void {
    const visibleTracks = this.getVisibleTracks(map);
    const nextVisibility = nextSettings.trackVisibility;
    if (!nextVisibility) return;

    const nextVisibleStates = new Map(
      nextVisibility.placeStates
        .filter(state => state.showOnLoad)
        .map(state => [state.placeId, state])
    );

    for (const [placeId, trackData] of Array.from(visibleTracks.entries())) {
      const nextState = nextVisibleStates.get(placeId);
      const nextSignature = nextState ? getTrackStateRenderSignature(nextState) : undefined;
      const changed = !nextState || !nextSignature || trackData.renderSignature !== nextSignature;

      if (changed) {
        trackData.trackLayers.forEach(trackLayer => trackLayer.removeFrom(map));
        visibleTracks.delete(placeId);
      }
    }

    for (const state of nextVisibleStates.values()) {
      if (!visibleTracks.has(state.placeId)) {
        const trackLayers: Layer[] = [];
        this.addTrackToMap(map, state.place, state.style, nextSettings.trackColorBy, nextSettings.trackGradeWindow, trackLayers, state.outline, nextSettings.trackSpeedWindow);
        visibleTracks.set(state.placeId, { place: state.place, settings: nextSettings, trackLayers, renderSignature: getTrackStateRenderSignature(state) });
      } else {
        const existing = visibleTracks.get(state.placeId);
        if (existing) {
          existing.place = state.place;
          existing.settings = nextSettings;
          existing.renderSignature = getTrackStateRenderSignature(state);
        }
      }
    }
  }

  private getTrackRenderSignature(place: MapPlace, visibility?: TrackVisibilityResult): string {
    const placeId = getPlaceId(place);
    const state = visibility?.placeStateMap.get(placeId);
    return state ? getTrackStateRenderSignature(state) : getPlaceTrackRenderHash(place);
  }

  private buildMarkerDataList(geoJsonData: PlacesGeoJsonFeatureCollection, places: MapPlace[], settings: CommonMapSettings): MarkerData[] {
    return this.createMarkerDataList(geoJsonData, places, settings.showLabels, false);
  }

  private extendBoundsWithOverlays(boundingBox: PlacesBoundingBox, overlays: MapRenderRequest['runtime']['overlays'], debug: boolean): void {
    const result = extendBoundingBoxWithOverlays(boundingBox, overlays);
    if (debug) {
      logger.scope('Places').info('[Leaflet Bounds] Processed overlays:', result.overlays.length, 'bounds:', boundingBox.getConventionalLatLngBounds());
    }
  }

  private calculateOverlayBounds(geojson: GeoJson.GeoJSON): { bounds: LatLngBounds; center: LatLng } | null {
    const bounds = PlacesBoundingBox.fromGeoJSON(geojson);
    if (!bounds.isValid()) return null;
    return {
      bounds: new LatLngBounds([bounds.minLat, bounds.minLng], [bounds.maxLat, bounds.maxLng]),
      center: new LatLng((bounds.minLat + bounds.maxLat) / 2, (bounds.minLng + bounds.maxLng) / 2)
    };
  }

  private createOverlayPopup(_map: LeafletMap, feature: PlacesGeoJsonFeature): HTMLElement {
    const properties = feature.properties || {};
    const sourcePath = scalarToString(properties._overlaySource) || undefined;
    return buildOverlayPointPopupContent({
      properties,
      sourcePath,
      defaultName: 'Point',
      onSourceLinkClick: createSourceLinkClickHandler(sourcePath, (linkPath) => void this.app.workspace.openLinkText(linkPath, ''))
    });
  }

  setGeocodingSearchMarkers(places: MapPlace[], container: HTMLElement): void {
    const mapState = getMapProviderState<LeafletMapState>(container, LEAFLET_PROVIDER_STATE_ID);
    if (!mapState) return;
    const { map } = mapState;

    mapState.geocodingMarkers.forEach(m => m.remove());
    mapState.geocodingMarkers = [];

    if (places.length === 0) {
      container.removeClass('places-focus-mode');
      return;
    }

    container.addClass('places-focus-mode');

    const containerSize = MarkerConstants.desktop.containerSize;
    const anchor = getIconAnchor('desktop');
    const popupAnchorOffset = getPopupAnchor('desktop');

    for (const place of places) {
      const html = `<div class="leaflet-marker-icon-container places-marker places-marker-search-result">
        <span class="leaflet-marker-icon-emoji places-marker-icon">${place.icon}</span>
      </div>`;
      const marker = new Marker([place.latitude, place.longitude], {
        icon: new DivIcon({
          className: 'leaflet-marker-icon',
          html,
          iconSize: [120, containerSize],
          iconAnchor: anchor,
          popupAnchor: popupAnchorOffset
        })
      });
      marker.bindPopup(() => buildGeocodingSearchPopupContent(place, mapState.settings.onPlaceAction, () => marker.closePopup()), {
        className: 'places-popup',
        trackResize: true
      });
      marker.addTo(map);
      marker.getElement()?.addClass('places-marker-search-result');
      mapState.geocodingMarkers.push(marker);
    }
  }
}

// The user's own `transform` from an iconStyles rule, for appending a rotation to.
function extractTransform(inlineCss: string | undefined): string {
  return /(?:^|;)\s*transform\s*:\s*([^;]+)/i.exec(inlineCss ?? '')?.[1]?.trim() ?? '';
}

function rememberRouteOverlayMatch(layer: Layer, feature: GeoJson.Feature | undefined, overlayGeoJson: GeoJson.GeoJSON): void {
  if (!feature) return;
  const match = classifyRouteOverlayFeature(feature, overlayGeoJson);
  if (match) routeOverlayMatchByLayer.set(layer, match);
}

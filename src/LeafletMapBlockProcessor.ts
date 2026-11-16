import { openLocalFile } from "places-shared/obsidian/utils";
import { runCooperativeWork } from "places-shared/utils";
import { trackGradientWork, extractCoordinatesFromOverlayWork, resolveOverlayTrackDataWork } from "places-shared/track";
import { LeafletClusterCircles } from './LeafletClusterCircles';
import { LeafletClusterHeatmap } from './LeafletClusterHeatmap';
import { CLUSTER_HEATMAP_HIT_LIMIT, CLUSTER_HEATMAP_HIT_TOLERANCE_PX, explicitMarkerZIndex } from "places-shared/map";
import { isStyleHidden } from "places-shared/place";
import { App, Component } from "obsidian";
import { hasTrackData } from "places-shared/place";
import { type UnitsSystem } from "places-shared/units";
import { PlacesBoundingBox, convertPlacesToFeatureCollection } from "places-shared/geo";
import { TrackRenderer, TrackRenderResult, TRACK_STYLE_DEFAULTS, PlaceTrackState, getPlaceId, getPlaceMarkerRenderSignature, getStyleForPlace, getTrackRenderSignature, syncVisibleTrackEntries, collectViewportTrackCandidates, selectViewportTracks, mergeWithDefaults, resolveTrackAppearance, dashArrayToPixels, type TrackColorBy } from "places-shared/track";
import { MapPlace, parseMapPlaceProperty, isGeoJSONOverlay, isImageOverlay, extendBoundingBoxWithOverlays, extractOverlayPointFeatures as extractOverlayPointFeaturesFromOverlays, getGeoJsonFeatures, resolveOverlayRenderBand, type GeoJSONOverlay, type ImageOverlay as PlacesImageOverlay } from "places-shared/overlay";
import { buildPagedPopupContent, type MapHit, type MapHitKind, appendTrackInspectionSection, dispatchMapTrackSelection, TRACK_INSPECTION_REQUEST_EVENT, TRACK_POINT_SELECT_EVENT, WAYPOINT_EMOJI_SIZE_PX, WAYPOINT_ICON_PROPERTY, attachMapSurfacePlumbing, withGuardedCamera, persistMapViewport, hasPlaceMarker, isNonInteractivePlace, ViewportClusteringManager, type ClusteringBounds } from "places-shared/map";
import { TileFailureMonitor, describeTileFailure } from "./TileFailureMonitor";
import { TrackDetailsPanel, configureMapContainer, createMapContextMenu, setSearchResultMarkers, resolveOverlayPointSource, buildOverlayPointPopup } from "places-shared/obsidian/map";
import { popupContentSignal, ownPopupContent, renderFeaturePopupContentAsync, renderPopupContentAsync } from "places-shared/obsidian/map";
import { markerPictureCssUrl, MarkerStyleService, buildPopupContent, buildWaypointPopupContent, buildGeocodingSearchPopupContent, buildGeoJsonFeaturePopupContent, buildOverlayPointPopupContent, createSourceLinkClickHandler, resolveClusteringDecision, classifyRouteOverlayFeature, type RouteOverlayFeatureMatch, getMapProviderState, setMapProviderState, clearMapProviderState, type MapProviderLifecycle, addSharedDebugOverlay, createLeafletDebugOverlayAdapter, estimateInitialZoom, updateZoomContainerState, getZoomRangeClassNames, type ZoomRange, ensureMapSurfaceLifecycle, createMapCameraGuard, type MapCameraGuard } from "places-shared/map";
import { IPlaceExtensionSettings, type MapPrepareTimings, type MapRenderRequest, type ResolvedMapConfig, DEFAULT_GRADE_WINDOW, type MetricWindow } from "places-shared/settings";
import { MapBlockProcessorBase, CommonMapSettings } from "places-shared/obsidian/services";
import { type MapControlHandle, type MapDataUpdateContext, type MapDataUpdateResult, type MapCameraApplyResult, type MapIncrementalUpdateCapabilities } from "places-shared/services";
import { resolveFitDataCamera, hasOverlayRenderableChanges, hasTrackRenderableChanges, type MapCameraIntent } from "places-shared/render";
import { logger, createPerformanceMonitor, parseContributingFiles, readNormalizedProperty, scalarToString, renderMapSupplementalError, type PerformanceMonitor } from "places-shared/utils";
import { MarkerConstants, getIconAnchor, getPopupAnchor } from "./MarkerConstants";
import { getTileLayerConfig } from "./TileLayerStyles";
import { ObsidianTileLayer } from "./ObsidianTileLayer";
import { LabelVisibilityManager, type MarkerInfo } from "./LabelVisibilityManager";
import { ensureLeafletOverlayPanes, getLeafletOverlayPane } from './LeafletOverlayOrdering';
import { LeafletHitRegistry, type LeafletHitTarget } from './LeafletHitCollection';
import { attachLeafletDevicePositionControl } from './LeafletDevicePositionControl';

import 'leaflet/dist/leaflet.css';
import { Map as LeafletMap, DivIcon, Marker, Polyline, LatLngBounds, LatLng, DomEvent, GeoJSON, Layer, CircleMarker, ImageOverlay, Popup, Canvas, LayerGroup, version as leafletVersion } from "leaflet";
import { GradientPolyline } from './GradientPolyline';
import { TrackCanvas } from './TrackCanvas';
import type { LeafletMouseEvent, LeafletEvent } from "leaflet";
import type * as GeoJson from "geojson";

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

function withProgrammaticCamera(map: LeafletMap, move: () => void): void {
  withGuardedCamera(cameraGuardFor(map), move);
}

// Leaflet autoPan can run after map removal and throw inside its ResizeObserver.
const PLACE_POPUP_OPTIONS = { className: 'places-popup', closeOnClick: false, autoClose: false, trackResize: true, autoPan: false } as const;

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

function escapeMarkerHtml(value: string): string {
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

const waypointDivIcons = new Map<string, DivIcon>();
const WAYPOINT_DIV_ICON_CACHE_LIMIT = 256;

function mappedWaypointDivIcon(icon: string): DivIcon {
  const cached = waypointDivIcons.get(icon);

  if (cached) return cached;
  const divIcon = new DivIcon({
    className: 'places-waypoint-marker places-waypoint-marker-emoji',
    html: escapeMarkerHtml(icon),
    iconSize: [WAYPOINT_EMOJI_SIZE_PX, WAYPOINT_EMOJI_SIZE_PX],
    iconAnchor: [WAYPOINT_EMOJI_SIZE_PX / 2, WAYPOINT_EMOJI_SIZE_PX / 2],
  });

  waypointDivIcons.set(icon, divIcon);

  if (waypointDivIcons.size > WAYPOINT_DIV_ICON_CACHE_LIMIT) {
    const oldest = waypointDivIcons.keys().next().value;

    if (oldest !== undefined) waypointDivIcons.delete(oldest);
  }

  return divIcon;
}

function createMappedWaypointMarker(latlng: LatLng, properties: Record<string, unknown>, pane?: string): Marker | undefined {
  const icon = properties[WAYPOINT_ICON_PROPERTY];

  if (typeof icon !== 'string' || !icon) return undefined;

  return new Marker(latlng, {
    ...(pane ? { pane } : {}),
    icon: mappedWaypointDivIcon(icon),
  });
}

function buildLabelMarkerInfo(marker: Marker): MarkerInfo {
  const sortKey = getLayerFeature(marker)?.properties?.labelSortKey;

  return {
    marker,
    labelElement: marker.getElement()?.querySelector('.leaflet-marker-icon-label') as HTMLElement | null,
    ...(typeof sortKey === 'number' ? { labelSortKey: sortKey } : {}) };
}

interface LeafletClustering {
  manager: ViewportClusteringManager<Marker>;
  setMarkerData(dataList: MarkerData[]): void;
}

interface ClusterDisplay {
  setMarkerData(dataList: readonly { latlng: LatLng }[]): void;
  setActive(active: boolean): void;
}

function clusteringMapAdapter(map: LeafletMap) {
  return {
    getBounds: (): ClusteringBounds => {
      const bounds = map.getBounds();

      return {
        getNorth: () => bounds.getNorth(),
        getSouth: () => bounds.getSouth(),
        getEast: () => bounds.getEast(),
        getWest: () => bounds.getWest(),
        contains: ([lng, lat]: [number, number]) => bounds.contains([lat, lng]),
      };
    },
    setLayoutProperty: () => undefined,
    getLayer: () => undefined,
    on: (event: string, handler: (...args: unknown[]) => void) => { map.on(event, handler); },
    off: (event: string, handler: (...args: unknown[]) => void) => { map.off(event, handler); },
    getZoom: () => map.getZoom(),
    getMaxZoom: () => map.getMaxZoom(),
  };
}

interface LeafletMapState {
  controlHandle?: MapControlHandle;
  map: LeafletMap;
  clustering: LeafletClustering | null;
  markerLayer: GeoJSON<Record<string, unknown>, GeoJson.Geometry> | null;
  currentPlaces: MapPlace[];
  settings: CommonMapSettings;
  blockSettings: ResolvedMapConfig;
  runtime: MapRenderRequest['runtime'];
  clusterThreshold: number;
  showClusters: boolean;
  codeBlockOverlayLayers: Layer[];
  lifecycle: MapProviderLifecycle;
  devicePositionControl: ReturnType<typeof attachLeafletDevicePositionControl> | null;
}

// Leaflet propagates a layer's contextmenu to the map with `propagatedFrom`.
// The right-click handler looks the match up by layer instead of hit-testing
// geometry.
const routeOverlayMatchByLayer = new WeakMap<Layer, RouteOverlayFeatureMatch>();

// Visible to the menu builder for the duration of one contextmenu dispatch.
let lastRightClickedRouteOverlay: RouteOverlayFeatureMatch | undefined;

const gradientCanvases = new WeakMap<LeafletMap, { renderer: Canvas; owners: number }>();

export class LeafletMapBlockProcessor extends MapBlockProcessorBase {
  private readonly trackDetailsPanels = new WeakMap<LeafletMap, TrackDetailsPanel>();
  private readonly hitRegistry = new LeafletHitRegistry();
  private readonly hitClickWiredMaps = new WeakSet<LeafletMap>();
  private readonly waypointOwners = new WeakMap<GeoJson.Feature, MapPlace>();
  private readonly hitPopups = new WeakMap<LeafletMap, Popup>();
  app: App;
  extensionSettings: IPlaceExtensionSettings;

  private readonly trackToggles = new WeakMap<LeafletMap, Map<string, boolean>>();

  private visibleTracksByMap = new WeakMap<LeafletMap, Map<string, VisibleTrackEntry>>();
  private readonly viewportTrackCleanups = new WeakMap<LeafletMap, () => void>();

  private getVisibleTracks(map: LeafletMap): Map<string, VisibleTrackEntry> {
    let tracks = this.visibleTracksByMap.get(map);

    if (!tracks) {
      tracks = new Map<string, VisibleTrackEntry>();
      this.visibleTracksByMap.set(map, tracks);
    }

    return tracks;
  }

  constructor(app: App, extensionSettings: IPlaceExtensionSettings, private readonly units: UnitsSystem, developerMode = false, private readonly userAgent?: string) {
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

    // Leaflet handles touch gestures in JavaScript and requires touch-action: none.
    mapContainerElement.addClass('places-leaflet-touch-target');

    const settings = perf.measure('extract-settings', () => this.extractCommonSettings(blockSettings, runtime));
    const isHeatmapLayer = blockSettings.heatmapLayer;

    configureMapContainer(mapContainerElement, { className: 'leaflet-map', css: blockSettings.css });

    if (runtime.isStale?.()) {
      perf.mark('superseded');
      logger.scope('MapSurface').debug('Leaflet map render abandoned - section superseded', { source: runtime.source.path });

      return;
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
    const fit = resolveFitDataCamera(cameraIntent.kind === 'fit-data' ? cameraIntent : {});
    const fitOptions = { padding: [fit.padding, fit.padding] as [number, number], maxZoom: fit.maxZoom, animate: false };

    const shouldFitInitialBounds = cameraIntent.kind === 'fit-data' && isValidBounds;
    let initialFit: LatLngBounds | null = null;
    const mapCenter = initialCenter
        ? new LatLng(initialCenter[1], initialCenter[0])
        : center;
    const mapZoom = initialZoom ?? estimateInitialZoom(boundingBox);

    const map = perf.measure('create-map', () => new LeafletMap(mapContainerElement, {
      center: mapCenter,
      zoom: mapZoom,
      minZoom: this.getMinZoom(blockSettings),
      maxZoom: mapMaxZoom,
      trackResize: false
    }), { initialZoom: mapZoom });

    logger.scope('MapSurface').debug('Leaflet map runtime created', {
      source: runtime.source.path,
      engine: 'leaflet',
      engineVersion: leafletVersion,
      mapClass: map.constructor?.name ?? 'unknown',
      places: places.length });
    ensureLeafletOverlayPanes(map);

    const surfaceLifecycle = ensureMapSurfaceLifecycle(mapContainerElement);

    surfaceLifecycle.reportCreated();

    const visibleTracks = this.getVisibleTracks(map);

    let disposed = false;
    const lifecycle: MapProviderLifecycle = {
      cleanup: () => component.unload(),
      hasActiveInstance: () => !disposed
    };

    component.register(() => {
      disposed = true;
      const mapState = getMapProviderState<LeafletMapState>(mapContainerElement, LEAFLET_PROVIDER_STATE_ID);

      mapState?.clustering?.manager.destroy();
      if (mapState) mapState.clustering = null;
      mapState?.markerLayer?.remove();
      if (mapState) mapState.markerLayer = null;
      mapState?.devicePositionControl?.dispose();
      if (mapState) mapState.devicePositionControl = null;
      this.viewportTrackCleanups.get(map)?.();
      map.closePopup();
      map.remove();
      clearMapProviderState(mapContainerElement, LEAFLET_PROVIDER_STATE_ID);
      surfaceLifecycle.reportDestroyed();
    });

    map.on('popupopen', event => {
      const content = event.popup.getContent();

      if (content && typeof content !== 'string' && typeof content !== 'function') {
        ownPopupContent(content, dispose => event.popup.once('remove', dispose));
      }
    });

    component.load();

    component.register(attachMapSurfacePlumbing({
      container: mapContainerElement,
      engine: {
        on: (event, handler) => { map.on(event, handler); },
        getCenter: () => map.getCenter(),
        getZoom: () => map.getZoom(),
        resize: () => map.invalidateSize(),
      },
      source: runtime.source,
      guard: cameraGuardFor(map),
      measure: (event, work, details, options) => perf.measure(event, work, details, options),
    }));

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
      ...(this.userAgent ? { userAgent: this.userAgent } : {}),
      onTileSuccess: () => tileFailures.recordSuccess(),
      onTileFailure: (url, error) => tileFailures.recordFailure(url, error) }).addTo(map));

    tileLayer.once('load', () => {
      surfaceLifecycle.reportLoaded();
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
      placeCount: places.filter(hasPlaceMarker).length,
      overlayPointCount: overlayPointFeatures.length,
      clusterThreshold: blockSettings.clusterThreshold,
      clusterGeoJsonOverlays: blockSettings.clusterGeoJsonOverlays });
    const { shouldCluster, unifiedClusteringActive } = clusteringDecision;

    if (isHeatmapLayer) {
      this.renderHeatmapLayer(map, places, blockSettings.heatmapColorScheme);

      if (shouldFitInitialBounds) {
        withProgrammaticCamera(map, () => map.fitBounds(latLngBounds, fitOptions));
      }
    } else {
      let clustering: LeafletClustering | null = null;
      let markerLayer: LeafletMapState['markerLayer'] = null;

      if (shouldCluster) {
        clustering = perf.measure('add-clustered-markers', () => this.addClusteredMarkers(geoJsonData, map, mapContainerElement, settings, places, blockSettings, overlayPointFeatures, perf), {
          places: places.length,
          overlayPointFeatures: overlayPointFeatures.length,
          clusterThreshold: blockSettings.clusterThreshold });
      } else {
        markerLayer = perf.measure('add-icon-markers', () => this.addLayerToMap(geoJsonData, map, settings), { places: places.length });
      }

      const mapState: LeafletMapState = {
        map,
        clustering,
        markerLayer,
        currentPlaces: places,
        settings,
        blockSettings,
        runtime,
        clusterThreshold: blockSettings.clusterThreshold,
        showClusters: shouldCluster,
        codeBlockOverlayLayers: [],
        lifecycle,
        devicePositionControl: null,
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

          perf.measure('add-single-track', () => this.addTrackToMap(map, place, style, colorBy, settings.trackGradeWindow, trackLayers, outline, settings.trackSpeedWindow), { placeId });
          const overlayBounds = cameraIntent.kind === 'fit-data' && place.overlay?.geojson ? this.calculateOverlayBounds(place.overlay.geojson) : null;

          if (overlayBounds) {
            initialFit = overlayBounds.bounds;
          }

          visibleTracks.set(placeId, { place, settings, trackLayers, renderSignature: getTrackRenderSignature(place, settings.trackVisibility) });
        } else if (placesToShow.length > 0) {
          perf.measure('show-initial-tracks', () => this.showInitialTracks(map, placesToShow, settings, perf), { tracks: placesToShow.length });
        }
      } else if (shouldCluster) {
        logger.scope('Places').debug('[Leaflet] Clustering enabled - trackLayers will show when markers are unclustered');
      }
    }

    map.whenReady(() => {
      perf.mark('map-ready', { zoom: map.getZoom() });
      withProgrammaticCamera(map, () => {
        map.invalidateSize();

        if (initialFit) {
          map.fitBounds(initialFit, fitOptions);
        } else if (shouldFitInitialBounds) {
          map.fitBounds(latLngBounds, fitOptions);
        }
      });
      updateZoomContainerState(mapContainerElement, map.getZoom());
      logger.scope('MapSurface').debug('Leaflet map ready', {
        source: runtime.source.path,
        engine: 'leaflet',
        engineVersion: leafletVersion,
        elapsedMs: Date.now() - loadStartTime,
        zoom: map.getZoom(),
        sized: surfaceLifecycle.getState().sized });
    });

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

    perf.measure('setup-context-menu', () => this.setupContextMenu(map, mapContainerElement, request, places));
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

  private isMarkerHidden(mapPlace?: MapPlace): boolean {
    return mapPlace?.markerEnabled === false || isStyleHidden(mapPlace?.iconStyle);
  }

  private buildMarkerHtml(feature: PlacesGeoJsonFeature, mapPlace: MapPlace | undefined, showLabels: boolean, includeContainerStyle = true): string {
    const iconStyle = mapPlace?.iconStyle;
    const dataAttrsStr = mapPlace?.dataAttributes
      ? MarkerStyleService.buildDataAttributesString(mapPlace.dataAttributes)
      : '';
    const rotation = mapPlace?.iconRotation;
    const iconStyleCss = [
      iconStyle?.inlineCss || '',
      rotation === undefined ? '' : `transform: ${extractTransform(iconStyle?.inlineCss)} rotate(${rotation}deg); transform-origin: center`,
    ].filter(Boolean).join('; ');
    const labelStyle = mapPlace?.labelStyle;
    const labelStyleCss = labelStyle?.inlineCss || '';
    const labelHidden = isStyleHidden(labelStyle);
    const iconClasses = iconStyle?.classes?.join(' ') || '';
    const labelClasses = [
      labelStyle?.hasUserStyle ? 'places-marker-label-user-style' : '',
      labelStyle?.classes?.join(' ') || '',
    ].filter(Boolean).join(' ');
    const containerZoomClasses = getZoomRangeClassNames(iconStyle?.zoom).join(' ');
    const zIndex = mapPlace ? explicitMarkerZIndex(mapPlace) : iconStyle?.zIndex;
    const containerStyle = [
      zIndex !== undefined ? `--places-marker-z-index: ${zIndex}` : '',
    ].filter(Boolean).join('; ');
    const zIndexClass = zIndex !== undefined ? 'places-marker-z-index-custom' : '';
    const placeIdAttr = mapPlace ? `data-place-id="${escapeMarkerHtml(getPlaceId(mapPlace))}"` : '';
    const styleAttr = includeContainerStyle && containerStyle ? `style="${escapeMarkerHtml(containerStyle)}"` : '';

    const iconOpacityCss = iconStyle?.opacity !== undefined ? `opacity: ${iconStyle.opacity}` : '';
    const iconCss = [iconStyleCss, iconOpacityCss].filter(Boolean).join('; ');

    const pictureUrl = mapPlace?.iconImageUrl;
    const pictureStyle = pictureUrl ? mapPlace?.iconImageStyle : undefined;
    const pictureCss = pictureUrl
      ? [`--places-marker-picture: ${markerPictureCssUrl(pictureUrl)}`, pictureStyle?.inlineCss].filter(Boolean).join('; ')
      : '';
    const pictureClass = pictureUrl ? ['places-marker-icon-picture', ...(pictureStyle?.classes ?? [])].join(' ') : '';
    const iconText = pictureUrl ? '' : escapeMarkerHtml(scalarToString(feature.properties?.icon));

    let html = `<div class="leaflet-marker-icon-container places-marker ${zIndexClass} ${containerZoomClasses}" ${dataAttrsStr} ${placeIdAttr} ${styleAttr}>
      <span class="leaflet-marker-icon-emoji places-marker-icon ${pictureClass} ${escapeMarkerHtml(iconClasses)}" style="${escapeMarkerHtml([iconCss, pictureCss].filter(Boolean).join('; '))}">${iconText}</span>`;

    if (showLabels && !labelHidden) {
      html += `<span class="leaflet-marker-icon-label leaflet-marker-icon-label-hidden places-marker-label ${escapeMarkerHtml(labelClasses)}" style="${escapeMarkerHtml(labelStyleCss)}">${escapeMarkerHtml(scalarToString(feature.properties?.description))}</span>`;
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

  private addLayerToMap(geoJsonData: PlacesGeoJsonFeatureCollection, map: LeafletMap, settings: CommonMapSettings): GeoJSON<Record<string, unknown>, GeoJson.Geometry> {
    const icons = new Array<Marker>();
    const showLabels = settings.showLabels;

    const markers = new GeoJSON<Record<string, unknown>, GeoJson.Geometry>(geoJsonData, {
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
            iconSize: [120, containerSize],  
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
    });

    this.bindPlacePopup(markers, map, settings);
    markers.addTo(map);

    const disposeLabels = showLabels
      ? LabelVisibilityManager.setupLabelVisibility(map, icons.map(buildLabelMarkerInfo), LabelVisibilityManager.createLeafletPositionGetter(map))
      : undefined;

    icons.length = 0;
    markers.once('remove', () => {
      disposeLabels?.();
      markers.getPopup()?.setContent('');
      markers.unbindPopup();
      markers.eachLayer(layer => {
        delete (layer as FeatureLayer).feature;
        layer.off();
      });
      markers.clearLayers();
      markers.off();
    });

    return markers;
  }

  private addClusteredMarkers(geoJsonData: PlacesGeoJsonFeatureCollection, map: LeafletMap, container: HTMLElement, settings: CommonMapSettings, places: MapPlace[], blockSettings: ResolvedMapConfig, overlayPointFeatures: PlacesGeoJsonFeature[] = [], perf?: PerformanceMonitor): LeafletClustering {
    const buildMarkerData = (nextPlaces: MapPlace[], nextGeoJson: PlacesGeoJsonFeatureCollection): MarkerData[] => {
      const list = this.createMarkerDataList(nextGeoJson, nextPlaces, settings.showLabels, true);

      overlayPointFeatures.forEach(feature => {
        if (feature.geometry.type !== 'Point') return;

        const coords = (feature.geometry).coordinates;
        const latlng = new LatLng(coords[1], coords[0]);
        const props = feature.properties || {};

        const configuredWaypointIcon = props[WAYPOINT_ICON_PROPERTY];
        const waypointIcon = typeof configuredWaypointIcon === 'string' && configuredWaypointIcon
          ? configuredWaypointIcon
          : '📍';
        const html = `<div class="leaflet-marker-icon-container places-marker places-overlay-marker">
          <span class="leaflet-marker-icon-emoji places-marker-icon">${escapeMarkerHtml(waypointIcon)}</span>
        </div>`;

        list.push({
          latlng,
          html,
          place: { name: scalarToString(props.name) || scalarToString(props.title) || 'Point', latitude: coords[1], longitude: coords[0], icon: waypointIcon },
          feature
        });
      });

      return list;
    };

    let markerDataList = buildMarkerData(places, geoJsonData);
    const createdMarkers = new Map<string, Marker>();
    const heatmap = blockSettings.clusterStyle === 'heatmap' ? new LeafletClusterHeatmap(map, blockSettings.heatmapColorScheme) : null;
    const clusterDisplay: ClusterDisplay = heatmap ?? new LeafletClusterCircles(map, 50);

    clusterDisplay.setMarkerData(markerDataList);

    const createMarker = (index: number): Marker => {
      const data = markerDataList[index];
      const marker = new Marker(data.latlng, {
        icon: new DivIcon({
          className: "leaflet-marker-icon",
          html: data.html,
          iconSize: [120, MarkerConstants.desktop.containerSize],
          iconAnchor: getIconAnchor('desktop'),
          popupAnchor: getPopupAnchor('desktop')
        })
      });

      (marker as FeatureLayer).feature = data.feature;

      if (data.feature.properties?._isOverlayPoint) {
        this.registerHit(map, marker, 'waypoint', () => ({ feature: data.feature }));
      } else {
        this.bindPlacePopup(marker, map, settings);
      }

      return marker;
    };

    const updateLabels = () => {
      if (!settings.showLabels || manager.isClustering()) return;
      const visibleMarkers = [...manager.getMarkerMap().values()];

      if (visibleMarkers.length > 0) {
        LabelVisibilityManager.updateLabelsOnce(visibleMarkers.map(buildLabelMarkerInfo), LabelVisibilityManager.createLeafletPositionGetter(map));
      }
    };

    const visibleTracks = this.getVisibleTracks(map);
    const placeById = new Map<string, MapPlace>();

    for (const place of places.filter(p => hasTrackData(p) && !isNonInteractivePlace(p))) {
      placeById.set(getPlaceId(place), place);
    }

    const syncTracks = (isClustering: boolean, visiblePlaceIds: Set<string>) => {
      const visibility = settings.trackVisibility;

      if (isClustering) {
        for (const trackData of visibleTracks.values()) {
          for (const trackLayer of trackData.trackLayers) trackLayer.remove();
        }

        visibleTracks.clear();

        return;
      }

      const current = getMapProviderState<LeafletMapState>(container, LEAFLET_PROVIDER_STATE_ID);
      const visibleTrackIds = new Set(visiblePlaceIds);
      const trackOnly = collectViewportTrackCandidates((current?.currentPlaces ?? places).filter(place => place.markerEnabled === false));
      const bounds = map.getBounds();

      for (const candidate of selectViewportTracks(trackOnly, {
        minLng: bounds.getWest(), maxLng: bounds.getEast(), minLat: bounds.getSouth(), maxLat: bounds.getNorth(),
      }, { isActive: candidate => visibleTracks.has(candidate.placeId) }).desired) visibleTrackIds.add(candidate.placeId);

      for (const placeId of visibleTrackIds) {
        const state = (current?.settings.trackVisibility ?? visibility)?.placeStateMap.get(placeId);
        const place = state?.place ?? placeById.get(placeId);

        if (!(this.trackToggles.get(map)?.get(placeId) ?? state?.showOnLoad) || !place?.overlay || visibleTracks.has(placeId)) continue;
        const trackLayers: Layer[] = [];
        const { style, outline } = getStyleForPlace(visibility, placeId);

        this.measureIf(perf, 'cluster-add-visible-trackLayer', () => this.addTrackToMap(map, place, style, settings.trackColorBy, settings.trackGradeWindow, trackLayers, outline, settings.trackSpeedWindow), { placeId }, { slowOnly: true });
        visibleTracks.set(placeId, { place, settings, trackLayers, renderSignature: getTrackRenderSignature(place, visibility) });
      }

      for (const [placeId, trackData] of Array.from(visibleTracks.entries())) {
        if (visibleTrackIds.has(placeId)) continue;
        for (const trackLayer of trackData.trackLayers) trackLayer.remove();
        visibleTracks.delete(placeId);
      }
    };

    const manager = new ViewportClusteringManager<Marker>({
      map: clusteringMapAdapter(map),
      places: markerDataList.map(data => data.place),
      clusterThreshold: blockSettings.clusterThreshold,
      providerName: 'Leaflet',
      markersLayerIds: [],
      markerFactory: {
        createMarker: (place, index) => {
          const placeId = getPlaceId(place);
          let marker = createdMarkers.get(placeId);

          if (!marker) {
            marker = createMarker(index);
            createdMarkers.set(placeId, marker);
          }

          marker.addTo(map);

          return marker;
        },
        removeMarker: marker => { marker.remove(); },
      },
      getPlaceSignature: getPlaceMarkerRenderSignature,
      onClusteringModeChange: (isClustering, visiblePlaceIds) => {
        clusterDisplay.setActive(isClustering);
        syncTracks(isClustering, visiblePlaceIds);
        if (!isClustering) updateLabels();
      },
    });

    const surfaceLifecycle = ensureMapSurfaceLifecycle(container);
    const runWhenSized = () => { if (surfaceLifecycle.getState().sized) manager.update(); };

    map.whenReady(runWhenSized);
    map.on('unload', surfaceLifecycle.subscribe((_state, event) => { if (event === 'sized') manager.update(); }));

    if (heatmap) {
      this.hitRegistry.setProximitySource(map, event => (manager.isClustering()
        ? heatmap.pointsNear(event.containerPoint, CLUSTER_HEATMAP_HIT_TOLERANCE_PX)
          .map(index => markerDataList[index])
          .filter(data => data && !data.feature.properties?._isOverlayPoint)
          .slice(0, CLUSTER_HEATMAP_HIT_LIMIT)
          .map(data => data.place)
        : []));
      this.wireMapHitClick(map);
    }

    return {
      manager,
      setMarkerData: dataList => {
        markerDataList = dataList;
        createdMarkers.clear();
        clusterDisplay.setMarkerData(dataList);
        manager.updatePlaces(dataList.map(data => data.place));
      },
    };
  }

  private bindPlacePopup(layer: Layer, map: LeafletMap, settings: CommonMapSettings): void {
    this.registerHit(map, layer, 'marker', leaf => {
      const place = parseMapPlaceProperty(getLayerFeature(leaf)?.properties?.mapPlace);

      return place ? { place } : undefined;
    });

    layer.on('keypress', (event: LeafletEvent) => {
      if ((event as LeafletEvent & { originalEvent: KeyboardEvent }).originalEvent.code !== 'Enter') return;
      const target: unknown = event.propagatedFrom ?? event.target;

      if (!(target instanceof Layer)) return;
      const place = parseMapPlaceProperty(getLayerFeature(target)?.properties?.mapPlace);

      if (!place) return;
      if (place.overlay) this.toggleTrack(map, place, settings);
      const marker = target as Layer & { getLatLng?: () => LatLng };
      const latlng = marker.getLatLng?.();

      if (latlng) this.openPlacePopup(map, place, latlng, settings);
    });
  }

  private createPlacePopupContent(place: MapPlace, map: LeafletMap, settings: CommonMapSettings, onRendered: () => void): HTMLElement {
    const div = createDiv();

    if (place.metadata?.isWaypoint && !place.settings?.popup && !settings.popup) {
      return buildWaypointPopupContent({
        place,
        units: this.units,
        onSourceLinkClick: (linkPath) => openLocalFile(this.app, linkPath),
      });
    }

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
        onLinkClick: place.filePath ? (linkPath) => openLocalFile(this.app, linkPath) : undefined,
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

    if (place.filePath || place.settings?.popup || settings.popup) {
      renderPopupContentAsync(this.app, place, div, settings.popup, {
        markdownSourcePath: settings.popupSourcePath,
        popupRenderers: settings.popupRenderers,
        onRendered,
      });
    }

    return div;
  }

  private toggleTrack(map: LeafletMap, place: MapPlace, settings: CommonMapSettings, visible?: boolean): void {
    const visibleTracks = this.getVisibleTracks(map);
    const placeId = getPlaceId(place);

    let toggles = this.trackToggles.get(map);

    if (!toggles) this.trackToggles.set(map, toggles = new Map<string, boolean>());
    const nextVisible = visible ?? !visibleTracks.has(placeId);

    toggles.set(placeId, nextVisible);
    if (nextVisible === visibleTracks.has(placeId)) return;

    if (visibleTracks.has(placeId)) {
      const trackData = visibleTracks.get(placeId)!;

      trackData.trackLayers.forEach(trackLayer => trackLayer.removeFrom(map));
      visibleTracks.delete(placeId);
    } else {
      const trackLayers: Layer[] = [];
      const { style, outline } = getStyleForPlace(settings.trackVisibility, placeId);

      this.addTrackToMap(map, place, style, settings.trackColorBy, settings.trackGradeWindow, trackLayers, outline, settings.trackSpeedWindow);
      visibleTracks.set(placeId, { place, settings, trackLayers, renderSignature: getTrackRenderSignature(place, settings.trackVisibility) });
    }
  }

  private showInitialTracks(map: LeafletMap, placeStates: PlaceTrackState[], settings: CommonMapSettings, perf?: PerformanceMonitor): void {
    const visibleTracks = this.getVisibleTracks(map);
    const statesWithTracks = placeStates.filter(s => hasTrackData(s.place));

    this.setupViewportTrackLoading(map, statesWithTracks.map(s => s.place), settings, visibleTracks, perf);
  }

  private setupViewportTrackLoading(map: LeafletMap, places: MapPlace[], settings: CommonMapSettings, visibleTracks: Map<string, VisibleTrackEntry>, perf?: PerformanceMonitor): void {
    this.viewportTrackCleanups.get(map)?.();
    let candidatePlaces = places;
    let trackData = collectViewportTrackCandidates(candidatePlaces);

    const updateVisibleTracks = () => {
      const current = getMapProviderState<LeafletMapState>(map.getContainer(), LEAFLET_PROVIDER_STATE_ID);
      const currentPlaces = current?.currentPlaces ?? places;

      settings = current?.settings ?? settings;

      if (candidatePlaces !== currentPlaces) {
        candidatePlaces = currentPlaces;
        trackData = collectViewportTrackCandidates(currentPlaces);
      }

      const mapBounds = map.getBounds();
      const selection = selectViewportTracks(trackData, { minLng: mapBounds.getWest(), maxLng: mapBounds.getEast(), minLat: mapBounds.getSouth(), maxLat: mapBounds.getNorth() }, {
        isActive: data => visibleTracks.has(data.placeId),
        isHidden: id => !(this.trackToggles.get(map)?.get(id) ?? settings.trackVisibility?.placeStateMap.get(id)?.showOnLoad),
      });

      for (const data of selection.add) {
        const trackLayers: Layer[] = [];
        const { style, outline } = getStyleForPlace(settings.trackVisibility, data.placeId);

        this.measureIf(perf, 'viewport-add-trackLayer', () => this.addTrackToMap(map, data.place, style, settings.trackColorBy, settings.trackGradeWindow, trackLayers, outline, settings.trackSpeedWindow), { placeId: data.placeId }, { slowOnly: true });
        visibleTracks.set(data.placeId, { place: data.place, settings, trackLayers, renderSignature: getTrackRenderSignature(data.place, settings.trackVisibility) });
      }

      for (const data of selection.remove) {
        const trackEntry = visibleTracks.get(data.placeId);

        if (trackEntry) {
          trackEntry.trackLayers.forEach(p => p.removeFrom(map));
          visibleTracks.delete(data.placeId);
        }
      }

      if (selection.add.length > 0 || selection.remove.length > 0) {
        const finalRendered = visibleTracks.size;

        logger.scope('Places').info(`[Leaflet] Viewport update: +${selection.add.length} -${selection.remove.length} trackLayers (${finalRendered}/${trackData.length} visible)`);
      }
    };

    const instrumentedUpdateVisibleTracks = () => {
      this.measureIf(perf, 'viewport-trackLayer-update-total', updateVisibleTracks, { zoom: map.getZoom(), visibleTracks: visibleTracks.size });
    };

    instrumentedUpdateVisibleTracks();

    map.on('moveend', instrumentedUpdateVisibleTracks);

    const cleanup = () => {
      map.off('moveend', instrumentedUpdateVisibleTracks);
      map.off('unload', cleanup);
      this.viewportTrackCleanups.delete(map);
    };

    this.viewportTrackCleanups.set(map, cleanup);
    map.on('unload', cleanup);
  }

  private addTrackToMap(map: LeafletMap, place: MapPlace, style: 'solid' | 'dashed', coloringType?: TrackColorBy, gradeWindow?: MetricWindow, trackLayers?: Layer[], outlineOverride?: boolean, speedWindow?: MetricWindow, plainFallback = false): void {
    if (!place.overlay?.geojson) return;

    coloringType = plainFallback ? 'none' : place.trackColorBy ?? coloringType;
    const merged = resolveTrackAppearance(place, { style, colorBy: coloringType, outline: outlineOverride });

    if (coloringType && coloringType !== 'none') {
      const controller = new AbortController();
      const owner = new LayerGroup().addTo(map);

      owner.on('remove', () => controller.abort());
      trackLayers?.push(owner);
      const mode = coloringType;

      void trackGradientWork.run(function* () {
        const coordinates = yield* extractCoordinatesFromOverlayWork(place.overlay!);
        const derived = yield* resolveOverlayTrackDataWork(place.overlay!);

        return yield* TrackRenderer.createTrackRenderDataWork(coordinates, {
          coloringType: mode, elevations: derived?.elevation, times: derived?.time,
          gradeWindow: gradeWindow ?? DEFAULT_GRADE_WINDOW, speedWindow,
          style: merged, outlineOverride: merged.outline,
        });
      }, controller.signal).then(async renderData => {
        controller.signal.throwIfAborted();

        if (renderData?.type === 'colored') {
          await runCooperativeWork(this.renderColoredTrackWork(map, renderData, owner, place), controller.signal);
          controller.signal.throwIfAborted();
          const waypoints: Layer[] = [];

          this.addTrackWaypoints(map, place, waypoints);
          for (const layer of waypoints) owner.addLayer(layer);
        } else {
          const plain: Layer[] = [];

          this.addTrackToMap(map, place, style, 'none', gradeWindow, plain, outlineOverride, speedWindow, true);
          for (const layer of plain) owner.addLayer(layer);
        }
      }).catch(error => {
        if (!controller.signal.aborted) {
          owner.removeFrom(map);
          logger.scope('MapSurface').error('Track gradient preparation failed', error, { placeId: getPlaceId(place) });
        }
      });

      return;
    }

    const lineFilter = (feature: PlacesGeoJsonFeature | undefined) => {
      const type = feature?.geometry?.type;

      return type === 'LineString' || type === 'MultiLineString';
    };

    if (merged.outline) {
      const outlineLayer = new GeoJSON<Record<string, unknown>, GeoJson.Geometry>(place.overlay.geojson, {
        filter: lineFilter,
        style: () => ({
          color: merged.outlineColor,
          weight: merged.outlineWeight,
          opacity: merged.outlineOpacity,
          dashArray: dashArrayToPixels(merged.outlineDashArray, merged.outlineWeight) || undefined
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
      style: feature => {
        const props = feature?.properties;
        const weight = typeof props?.['stroke-width'] === 'number' ? props['stroke-width'] : merged.weight;

        return {
          color: typeof props?.stroke === 'string' ? props.stroke : merged.color,
          weight,
          opacity: typeof props?.['stroke-opacity'] === 'number' ? props['stroke-opacity'] : merged.opacity,
          dashArray: dashArrayToPixels(merged.dashArray, weight) || undefined
        };
      }
    }).addTo(map);

    if (place.overlay.pathLabels?.length) {
      const labelCollection = { type: 'FeatureCollection', features: place.overlay.pathLabels } as typeof place.overlay.geojson;
      const labelLayer = new GeoJSON<Record<string, unknown>, GeoJson.Geometry>(labelCollection, {
        pointToLayer: (feature, latlng) => new Marker(latlng, {
          interactive: false,
          icon: new DivIcon({
            className: 'places-route-label-marker',
            html: `<span class="places-route-label">${escapeMarkerHtml(scalarToString(feature.properties?.route_label))}</span>`,
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

    this.registerTrackHits(map, mainLayer, place);

    this.addTrackWaypoints(map, place, trackLayers);
  }

  private addTrackWaypoints(map: LeafletMap, place: MapPlace, trackLayers?: Layer[]): void {
    if (!place.overlay?.geojson) return;

    const waypointFeatures = getGeoJsonFeatures(place.overlay.geojson).filter(feature => {
      const type = feature.geometry?.type;

      return (type === 'Point' || type === 'MultiPoint') && !feature.properties?.route_label_point;
    });

    if (waypointFeatures.length === 0) return;

    const fillColor = mergeWithDefaults(place.overlay.style).color;
    const waypointCollection = { type: 'FeatureCollection', features: waypointFeatures } as typeof place.overlay.geojson;

    const waypointFeatureByLayer = new WeakMap<Layer, GeoJson.Feature>();
    const waypointLayer = new GeoJSON<Record<string, unknown>, GeoJson.Geometry>(waypointCollection, {
      pointToLayer: (feature, latlng) => {
        const props = feature?.properties || {};
        const mappedMarker = createMappedWaypointMarker(latlng, props);

        if (mappedMarker) return mappedMarker;

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
        waypointFeatureByLayer.set(layer, feature);
        this.waypointOwners.set(feature, place);
      }
    }).addTo(map);

    this.registerHit(map, waypointLayer, 'waypoint', leaf => {
      const feature = waypointFeatureByLayer.get(leaf);

      return feature ? { feature, ...(place.filePath ? { sourcePath: place.filePath } : {}) } : undefined;
    });

    trackLayers?.push(waypointLayer);
  }

  private buildOverlayPointContent(map: LeafletMap, feature: GeoJson.Feature, refresh: () => void): HTMLElement {
    const owner = this.waypointOwners.get(feature);

    return owner
      ? this.buildWaypointPointContent(map, owner, feature, refresh)
      : this.createOverlayPopup(map, feature as PlacesGeoJsonFeature);
  }

  private buildWaypointPointContent(map: LeafletMap, place: MapPlace, feature: GeoJson.Feature, refresh: () => void): HTMLElement {
    const settings = this.settingsFor(map);
    const content = buildOverlayPointPopupContent({
      properties: feature.properties ?? {},
      sourcePath: place.filePath,
      defaultName: 'Point',
      includeProperties: !(place.settings?.popup ?? settings.popup),
      onSourceLinkClick: createSourceLinkClickHandler(place.filePath, (linkPath) => openLocalFile(this.app, linkPath)),
    });

    if (place.settings?.popup) {
      renderPopupContentAsync(this.app, place, content, place.settings.popup, {
        markdownSourcePath: settings.popupSourcePath,
        popupRenderers: settings.popupRenderers,
        onRendered: refresh,
      });
    } else if (settings.popup) {
      renderFeaturePopupContentAsync(this.app, {
        kind: 'feature',
        feature,
        sourcePath: place.filePath,
        presentation: 'point',
        markdownSourcePath: settings.popupSourcePath,
      }, settings.popup, content, {
        popupRenderers: settings.popupRenderers,
        onRendered: refresh,
      });
    }

    return content;
  }

  private *renderColoredTrackWork(map: LeafletMap, renderData: TrackRenderResult, owner: LayerGroup, place?: MapPlace): Generator<void> {
    const style = mergeWithDefaults(renderData.style);
    const dashArray = dashArrayToPixels(style.dashArray, style.weight) || undefined;

    let shared = gradientCanvases.get(map);

    if (!shared) {
      shared = { renderer: new TrackCanvas().addTo(map), owners: 0 };
      gradientCanvases.set(map, shared);
    }

    const canvas = shared;
    const renderer = canvas.renderer;

    canvas.owners++;
    let released = false;

    owner.on('remove', () => {
      if (released) return;
      released = true;

      if (--canvas.owners === 0) {
        map.removeLayer(renderer);
        gradientCanvases.delete(map);
      }
    });

    if (renderData.needsOutline) {
      const allCoords: [number, number][] = [];

      for (let i = 0; i < renderData.trackCoords.length; i++) {
        const coord = renderData.trackCoords[i];

        allCoords.push([coord.latitude, coord.longitude]);
        if (i % 128 === 0) yield;
      }

      const continuousOutline = new Polyline(allCoords, {
        renderer,
        color: style.outlineColor,
        dashArray: dashArrayToPixels(style.outlineDashArray, style.outlineWeight) || undefined,
        weight: renderData.style.outlineWeight,
        opacity: renderData.style.outlineOpacity
      }).addTo(map);

      if (place) this.registerTrackHits(map, continuousOutline, place);

      owner.addLayer(continuousOutline);
      yield;
    }

    const coordinates: LatLng[][] = [];
    const colors: string[] = [];
    let previous: LatLng | undefined;
    let count = 0;

    for (const segment of renderData.segments) {
      if (!segment.coordinates.length) continue;
      const line = new Array<LatLng>(segment.coordinates.length);

      for (let i = 0; i < segment.coordinates.length; i++) {
        const coordinate = segment.coordinates[i];

        if (!previous || previous.lat !== coordinate.latitude || previous.lng !== coordinate.longitude) previous = new LatLng(coordinate.latitude, coordinate.longitude);
        line[i] = previous;
        if (++count % 128 === 0) yield;
      }

      coordinates.push(line);
      colors.push(segment.color);
    }

    const trackLayer = new GradientPolyline(coordinates, colors, {
      renderer,
      dashArray,
      weight: renderData.style.weight,
      opacity: renderData.style.opacity
    }).addTo(map);

    if (place) this.registerTrackHits(map, trackLayer, place);
    owner.addLayer(trackLayer);
  }

  private registerTrackHits(map: LeafletMap, layer: Layer, place: MapPlace): void {
    this.registerHit(map, layer, 'track', leaf => leaf instanceof Polyline ? { place } : undefined);
  }

  private registerHit(map: LeafletMap, layer: Layer, kind: MapHitKind, resolve: (leaf: Layer) => LeafletHitTarget | undefined): void {
    this.hitRegistry.register(map, layer, kind, resolve);
    layer.on('click', (event: LeafletMouseEvent) => this.answerHitClick(map, event));
    this.wireMapHitClick(map);
  }

  private wireMapHitClick(map: LeafletMap): void {
    if (this.hitClickWiredMaps.has(map)) return;
    this.hitClickWiredMaps.add(map);
    map.on('click', (event: LeafletMouseEvent) => this.answerHitClick(map, event));
  }

  private answerHitClick(map: LeafletMap, event: LeafletMouseEvent): void {
    const hits = this.hitRegistry.collect(map, event);

    if (hits.length === 0) return;
    if (this.claimMapClick(event.originalEvent)) return;

    const settings = this.settingsFor(map);

    if (hits.length === 1) {
      this.openSingleHit(map, hits[0], event.latlng, settings);

      return;
    }

    this.openHitStackPopup(map, hits, event.latlng, settings);
  }

  private claimMapClick(originalEvent: MouseEvent | undefined): boolean {
    if (!originalEvent) return false;

    const claimed = originalEvent as MouseEvent & { _placesHitAnswered?: boolean };

    if (claimed._placesHitAnswered) return true;
    claimed._placesHitAnswered = true;

    return false;
  }

  private openSingleHit(map: LeafletMap, hit: MapHit, latlng: LatLng, settings: CommonMapSettings): void {
    const coordinate = { latitude: latlng.lat, longitude: latlng.lng };

    if (hit.feature) {
      const feature = hit.feature;

      this.openLeafletPopup(map, latlng, popup => this.buildOverlayPointContent(map, feature, () => popup.update()), PLACE_POPUP_OPTIONS);

      return;
    }

    if (hit.kinds.includes('marker') || !hit.kinds.includes('track')) {
      if (hit.place.overlay) this.toggleTrack(map, hit.place, settings);
      this.openPlacePopup(map, hit.place, latlng, settings);

      return;
    }

    dispatchMapTrackSelection(map.getContainer(), { place: hit.place, coordinate, intent: 'preview', source: 'map-click' });

    if (settings.trackDetails === 'panel') {
      this.showTrackDetailsPanel(map, hit.place, coordinate, settings);

      return;
    }

    this.openLeafletPopup(map, latlng, popup => this.buildTrackPopupContent(hit.place, coordinate, settings, () => popup.update()), PLACE_POPUP_OPTIONS);
  }

  private openPlacePopup(map: LeafletMap, place: MapPlace, latlng: LatLng, settings: CommonMapSettings): void {
    this.openLeafletPopup(map, latlng, popup => this.createPlacePopupContent(place, map, settings, () => popup.update()), PLACE_POPUP_OPTIONS);
  }

  private openHitStackPopup(map: LeafletMap, hits: MapHit[], latlng: LatLng, settings: CommonMapSettings): void {
    const rendered = new Map<number, HTMLElement>();

    this.openLeafletPopup(map, latlng, popup => {
      const paged = buildPagedPopupContent({
        pages: hits.map(hit => ({ label: hit.label, icon: hit.icon, kind: hit.kind })),
        onShow: (index, host) => {
          const hit = hits[index];
          const body = rendered.get(index);

          if (body) {
            host.appendChild(body);
          } else {
            const page = host.createDiv({ cls: 'places-popup-page-body' });

            rendered.set(index, page);
            this.renderHitPage(map, hit, page, latlng, settings, () => popup.update());
          }

          if (hit.kinds.includes('track')) {
            dispatchMapTrackSelection(map.getContainer(), { place: hit.place, coordinate: { latitude: latlng.lat, longitude: latlng.lng }, intent: 'preview', source: 'map-click' });
          }

          popup.update();

          if (hit.kinds.includes('marker') && hasTrackData(hit.place)) {
            this.toggleTrack(map, hit.place, settings, true);

            return () => this.toggleTrack(map, hit.place, settings, false);
          }
        },
      });

      popup.once('remove', () => paged.dispose());

      return paged.element;
    }, PLACE_POPUP_OPTIONS);
  }

  private renderHitPage(map: LeafletMap, hit: MapHit, host: HTMLElement, latlng: LatLng, settings: CommonMapSettings, refresh: () => void): void {
    const coordinate = { latitude: latlng.lat, longitude: latlng.lng };

    if (hit.feature) {
      host.appendChild(this.buildOverlayPointContent(map, hit.feature, refresh));

      return;
    }

    host.appendChild(this.createPlacePopupContent(hit.place, map, settings, refresh));

    const inspectTrack = settings.inspectTrack;

    if (!hit.kinds.includes('track') || settings.trackDetails === 'panel' || !inspectTrack) return;
    appendTrackInspectionSection({
      host, place: hit.place, coordinate, inspectTrack,
      signal: popupContentSignal(host), onRendered: refresh,
    });
  }

  private openLeafletPopup(map: LeafletMap, latlng: LatLng, build: (popup: Popup) => HTMLElement, options: Popup['options']): void {
    this.closeHitPopup(map);

    const popup = new Popup(options).setLatLng(latlng);
    const content = build(popup);

    ownPopupContent(content, dispose => popup.once('remove', dispose));
    popup.once('remove', () => {
      content.replaceChildren();
      popup.setContent('');
      if (this.hitPopups.get(map) === popup) this.hitPopups.delete(map);
    });
    this.hitPopups.set(map, popup);
    popup.setContent(content).openOn(map);
  }

  private closeHitPopup(map: LeafletMap): void {
    this.hitPopups.get(map)?.removeFrom(map);
    this.hitPopups.delete(map);
  }

  // The rendered block's settings for THIS map, from the provider state keyed by
  // its container. One processor instance serves every Leaflet map in the vault.
  // Instance fields would hand a click on one map the most recently rendered map's
  // `onPlaceAction`, inspection window, and details mode.
  private settingsFor(map: LeafletMap): CommonMapSettings {
    return getMapProviderState<LeafletMapState>(map.getContainer(), LEAFLET_PROVIDER_STATE_ID)?.settings ?? ({} as CommonMapSettings);
  }

  private showTrackDetailsPanel(map: LeafletMap, place: MapPlace, coordinate: { latitude: number; longitude: number }, settings: CommonMapSettings): void {
    map.closePopup();
    let panel = this.trackDetailsPanels.get(map);

    if (!panel) {
      panel = new TrackDetailsPanel({
        container: map.getContainer(),
        openLink: (linkPath) => openLocalFile(this.app, linkPath),
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
      onLinkClick: place.filePath ? (linkPath) => openLocalFile(this.app, linkPath) : undefined,
      placeActions: place.actions,
      onPlaceAction: onPlaceAction ? (actionId, state) => onPlaceAction(place, actionId, state) : undefined,
    });

    const frequency = Number(scalarToString(place.metadata?.frequency)) || 0;
    const contributingFiles = parseContributingFiles(place.metadata?.contributingFiles);

    if (frequency > 0 || contributingFiles.length > 0) {
      content.appendChild(this.createFrequencyPopup(frequency, contributingFiles));
    }

    if (settings.inspectTrack) {
      appendTrackInspectionSection({ host: content, place, coordinate, inspectTrack: settings.inspectTrack, onRendered, signal: popupContentSignal(content) });
    }

    if (place.filePath || place.settings?.popup || settings.popup) {
      renderPopupContentAsync(this.app, place, content, settings.popup, {
        markdownSourcePath: settings.popupSourcePath,
        popupRenderers: settings.popupRenderers,
        onRendered,
      });
    }

    return content;
  }

  private getTileConfig(style?: string): { url: string; attribution: string; maxZoom: number } {
    return getTileLayerConfig(
      style,
      this.extensionSettings.tileLayerUrl,
      this.extensionSettings.tileLayerAttribution
    );
  }

  private addImageOverlays(map: LeafletMap, overlays: PlacesImageOverlay[]): Layer[] {
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
          opacity: overlay.style?.opacity ?? 1.0,
          interactive: false,
          pane: getLeafletOverlayPane(resolveOverlayRenderBand(overlay)),
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

  private addGeoJSONOverlays(map: LeafletMap, overlays: GeoJSONOverlay[], skipPointFeatures: boolean = false): Layer[] {
    const layers: Layer[] = [];

    overlays.forEach(overlay => {
      try {
        const pane = getLeafletOverlayPane(resolveOverlayRenderBand(overlay));

        const hitAreaLayer = new GeoJSON<Record<string, unknown>, GeoJson.Geometry>(overlay.geojson, {
          style: (feature) => {
            if (feature?.geometry?.type === 'LineString' || feature?.geometry?.type === 'MultiLineString') {
              return {
                color: 'transparent',
                weight: 15,
                opacity: 0,
                pane,
              };
            }

            return { opacity: 0, fillOpacity: 0, pane };
          },
          pointToLayer: () => {
            return new CircleMarker([0, 0], { opacity: 0, fillOpacity: 0, radius: 0, pane });
          },
          filter: (feature) => {
            return feature?.geometry?.type === 'LineString' || feature?.geometry?.type === 'MultiLineString';
          },
          onEachFeature: (feature, layer) => {
            rememberRouteOverlayMatch(layer, feature, overlay.geojson);
            layer.on('click', (e) => {
              DomEvent.stopPropagation(e);
              this.showGeoJsonFeaturePopup(map, feature, layer, overlay);
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
              dashArray = scalarToString(props['stroke-dasharray']) || undefined;
            } else {
              dashArray = TRACK_STYLE_DEFAULTS.dashArray.map(v => v * weight).join(', ');
            }

            return {
              color: scalarToString(props.stroke) || TRACK_STYLE_DEFAULTS.color,
              fillColor: scalarToString(props.fill) || TRACK_STYLE_DEFAULTS.color,
              weight,
              opacity: finiteNumberOr(props['stroke-opacity'], 1),
              fillOpacity: finiteNumberOr(props['fill-opacity'], 0.3),
              dashArray,
              pane,
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
                pane,
                icon: new DivIcon({
                  className: 'places-route-label-marker',
                  html: `<span class="places-route-label">${escapeMarkerHtml(scalarToString(props.route_label))}</span>`,
                  iconSize: [80, 24],
                  iconAnchor: [40, 12]
                })
              });
            }

            if (props.route_endpoint_label) {
              return new Marker(latlng, {
                interactive: true,
                pane,
                icon: new DivIcon({
                  className: 'places-route-label-marker',
                  html: `<span class="places-route-label">${escapeMarkerHtml(scalarToString(props.route_endpoint_label))}</span>`,
                  iconSize: [140, 24],
                  iconAnchor: [70, -6]
                })
              });
            }

            const mappedMarker = createMappedWaypointMarker(latlng, props, pane);

            if (mappedMarker) return mappedMarker;
            const radius = finiteNumberOr(props['circle-radius'], 5);

            return new CircleMarker(latlng, {
              radius,
              fillColor: scalarToString(props['marker-color']) || TRACK_STYLE_DEFAULTS.color,
              color: scalarToString(props.stroke) || '#ffffff',
              weight: finiteNumberOr(props['stroke-width'], 1),
              opacity: finiteNumberOr(props['stroke-opacity'], 1),
              fillOpacity: finiteNumberOr(props['fill-opacity'], 0.7),
              pane,
            });
          },
          onEachFeature: (feature, layer) => {
            rememberRouteOverlayMatch(layer, feature, overlay.geojson);
            const geomType = feature?.geometry?.type;

            if (geomType !== 'LineString' && geomType !== 'MultiLineString') {
              layer.on('click', (e) => {
                DomEvent.stopPropagation(e);
                this.showGeoJsonFeaturePopup(map, feature, layer, overlay);
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

  private showGeoJsonFeaturePopup(map: LeafletMap, feature: PlacesGeoJsonFeature, layer: Layer, overlay: GeoJSONOverlay): void {
    const properties = feature.properties || {};
    const geometryType = feature.geometry?.type || 'Feature';
    const settings = this.settingsFor(map);
    const popupDiv = buildGeoJsonFeaturePopupContent({
      properties,
      geometryType,
      sourcePath: overlay.source,
      includeProperties: !overlay.popup,
      onSourceLinkClick: createSourceLinkClickHandler(overlay.source, (linkPath) => openLocalFile(this.app, linkPath))
    });

    layer.bindPopup(popupDiv).openPopup();

    if (overlay.popup) {
      renderFeaturePopupContentAsync(this.app, {
        kind: 'feature',
        feature,
        sourcePath: overlay.source,
        markdownSourcePath: settings.popupSourcePath,
      }, overlay.popup, popupDiv, {
        popupRenderers: settings.popupRenderers,
        onRendered: () => (layer as { getPopup?: () => { update?: () => void } }).getPopup?.()?.update?.(),
      });
    }
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

  private setupContextMenu(map: LeafletMap, mapContainerElement: HTMLElement, request: MapRenderRequest, places: MapPlace[]): void {
    const contextMenu = createMapContextMenu({
      container: mapContainerElement,
      getRuntime: () => getMapProviderState<LeafletMapState>(mapContainerElement, LEAFLET_PROVIDER_STATE_ID)?.runtime ?? request.runtime,
      places,
      developerMode: this.developerMode,
      providerName: 'Leaflet',
      getCurrentPlaces: () => this.getCurrentPlaces(mapContainerElement) ?? undefined,
      findDirectionsRoute: () => lastRightClickedRouteOverlay?.kind === 'directions' ? lastRightClickedRouteOverlay.feature : null,
      findIsochrone: () => lastRightClickedRouteOverlay?.kind === 'isochrone' ? lastRightClickedRouteOverlay.collection : null,
      zoomTo: (place, zoom) => withProgrammaticCamera(map, () => map.setView([place.latitude, place.longitude], zoom, { animate: false })),
      placesInView: markerPlaces => {
        const bounds = map.getBounds();

        return markerPlaces.filter((place) => bounds.contains([place.latitude, place.longitude]));
      },
    });

    map.on('contextmenu', (event: LeafletMouseEvent) => {
      event.originalEvent.preventDefault();
      lastRightClickedRouteOverlay = event.propagatedFrom ? routeOverlayMatchByLayer.get(event.propagatedFrom as Layer) : undefined;
      const coordinate = { latitude: event.latlng.lat, longitude: event.latlng.lng };

      contextMenu.open(coordinate, event.originalEvent.clientX, event.originalEvent.clientY, event.originalEvent);
      lastRightClickedRouteOverlay = undefined;
    });

    map.on('unload', () => contextMenu.cleanup());
  }

  getMapControlHandle(container: HTMLElement): MapControlHandle | null {
    const mapState = getMapProviderState<LeafletMapState>(container, LEAFLET_PROVIDER_STATE_ID);

    if (!mapState) return null;
    const { map } = mapState;

    return mapState.controlHandle ??= {
      getBounds: () => {
        const bounds = map.getBounds();

        return new PlacesBoundingBox(bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast());
      },
      getViewState: () => {
        const bounds = map.getBounds();
        const center = map.getCenter();
        const size = map.getSize();

        return {
          bounds: new PlacesBoundingBox(bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast()),
          center: { latitude: center.lat, longitude: center.lng },
          zoom: map.getZoom(),
          bearing: 0,
          pitch: 0,
          width: size.x,
          height: size.y,
        };
      },
      onBoundsChanged: listener => {
        map.on('moveend zoomend resize', listener);

        return () => { map.off('moveend zoomend resize', listener); };
      },
      centerOnPlace: (place: MapPlace) => {
        map.setView([place.latitude, place.longitude], Math.max(map.getZoom(), 14), {
          animate: false });
      },
      highlightPlace: (place: MapPlace) => {
        this.highlightPlace(map, container, place);
      },
      clearHighlight: () => {
        this.clearPlaceHighlight(map, container);
      },
      setGeocodingSearchMarkers: (places: MapPlace[]) => {
        this.setGeocodingSearchMarkers(places, container);
      },
      setDevicePositionControl: button => {
        mapState.devicePositionControl?.dispose();
        mapState.devicePositionControl = button
          ? attachLeafletDevicePositionControl(map, button)
          : null;
      },
    };
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
      onLinkClick: place.filePath ? (linkPath) => openLocalFile(this.app, linkPath) : undefined
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

  private renderHeatmapLayer(map: LeafletMap, places: MapPlace[], colorScheme?: string): void {
    const heatmap = new LeafletClusterHeatmap(map, colorScheme);

    heatmap.setMarkerData(places.map(place => ({
      latlng: new LatLng(place.latitude, place.longitude),
      weight: Number(readNormalizedProperty(place.metadata, 'heatmapWeight')) || 1,
    })));
    heatmap.setActive(true);
    map.on('click', (event: LeafletMouseEvent) => {
      const index = heatmap.pointsNear(event.containerPoint, CLUSTER_HEATMAP_HIT_TOLERANCE_PX)[0];

      if (index === undefined) return;
      const place = places[index];
      const frequency = Number(place.metadata?.frequency ?? readNormalizedProperty(place.metadata, 'heatmapWeight')) || 1;

      new Popup(PLACE_POPUP_OPTIONS)
        .setLatLng(event.latlng)
        .setContent(this.createFrequencyPopup(frequency, parseContributingFiles(place.metadata?.contributingFiles)))
        .openOn(map);
    });
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

  async updateMapData(container: HTMLElement, newPlaces: MapPlace[], request: MapRenderRequest, context?: MapDataUpdateContext): Promise<MapDataUpdateResult> {
    const result = await this.performMapDataUpdate(container, newPlaces, request, context);

    if (result.updated === false && result.status === 'requires-rebuild') {
      const map = getMapProviderState<LeafletMapState>(container, LEAFLET_PROVIDER_STATE_ID)?.map;

      if (map?.getContainer()) persistMapViewport(map, request.runtime.source);
    }

    return result;
  }

  private performMapDataUpdate(container: HTMLElement, newPlaces: MapPlace[], request: MapRenderRequest, context?: MapDataUpdateContext): Promise<MapDataUpdateResult> {
    const blockSettings = request.config;
    const runtime = request.runtime;
    const perf = createPerformanceMonitor('leaflet-update', {
      provider: 'leaflet',
      source: runtime.source.path,
      places: newPlaces.length,
      overlays: runtime.overlays.length,
      trackDefaultVisibility: blockSettings.trackDefaultVisibility }, { enabled: this.developerMode });
    const ineligibleReason = this.getMapDataUpdateIneligibleReason(blockSettings);

    if (ineligibleReason) return Promise.resolve(this.declineUpdate(ineligibleReason, perf));

    const mapState = getMapProviderState<LeafletMapState>(container, LEAFLET_PROVIDER_STATE_ID);

    if (!mapState) return Promise.resolve(this.declineUpdate('no map state found', perf));

    const { map, clustering, currentPlaces, settings, showClusters } = mapState;

    if (!map || !map.getContainer()) return Promise.resolve(this.declineUpdate('map no longer valid', perf));

    if (mapState.blockSettings.showCurrentDevicePosition !== blockSettings.showCurrentDevicePosition) {
      return Promise.resolve(this.declineUpdate('showCurrentDevicePosition changed', perf));
    }

    if (mapState.blockSettings.clusterStyle !== blockSettings.clusterStyle) {
      return Promise.resolve(this.declineUpdate('cluster style changed', perf));
    }

    this.closeHitPopup(map);

    Object.assign(settings, this.extractCommonSettings(blockSettings, runtime));
    mapState.currentPlaces = newPlaces;
    mapState.settings = settings;
    mapState.blockSettings = blockSettings;
    mapState.runtime = runtime;

    if (hasOverlayRenderableChanges(context?.planDiff)) {
      perf.measure('sync-codeblock-overlays', () => this.syncCodeBlockOverlays(mapState, request));
    }

    if (hasTrackRenderableChanges(context?.planDiff)) {
      perf.measure('sync-visible-tracks', () => this.syncVisibleTrackOverlays(map, this.extractCommonSettings(blockSettings, runtime)), {
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

    if (showClusters && clustering) {
      const { featureCollection: geoJsonData } = convertPlacesToFeatureCollection(newPlaces);
      const markerDataList = this.buildMarkerDataList(geoJsonData, newPlaces, settings);

      perf.measure('cluster-update-marker-data', () => clustering.setMarkerData(markerDataList), { markerData: markerDataList.length });
    } else {
      perf.measure('remove-existing-markers', () => mapState.markerLayer?.remove());
      mapState.markerLayer = null;

      const { featureCollection: geoJsonData } = convertPlacesToFeatureCollection(newPlaces);

      mapState.markerLayer = perf.measure('rebuild-markers', () => this.addLayerToMap(geoJsonData, map, settings), { places: newPlaces.length });
    }

    if (!clustering && hasTrackRenderableChanges(context?.planDiff) && !settings.trackVisibility?.isSingleTrackView) {
      this.setupViewportTrackLoading(map, newPlaces, settings, this.getVisibleTracks(map), perf);
    }

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
        const fit = resolveFitDataCamera(camera);
        const bounds = new PlacesBoundingBox();

        for (const place of mapState.currentPlaces) {
          if (!isNonInteractivePlace(place)) bounds.update(place.latitude, place.longitude);
        }

        this.extendBoundsWithOverlays(bounds, request.runtime.overlays, request.config.debug);
        if (!bounds.isValid()) return { applied: false, reason: 'no valid data bounds' };
        const [[minLat, minLng], [maxLat, maxLng]] = bounds.getConventionalLatLngBounds();

        withProgrammaticCamera(map, () => map.fitBounds(new LatLngBounds([minLat, minLng], [maxLat, maxLng]), {
          padding: [fit.padding, fit.padding],
          maxZoom: fit.maxZoom,
          animate: false }));

        return { applied: true };
      }
      case 'explicit': {
        const currentCenter = map.getCenter();
        const center: [number, number] = camera.center ? [camera.center[1], camera.center[0]] : [currentCenter.lat, currentCenter.lng];

        withProgrammaticCamera(map, () => map.setView(center, camera.zoom ?? map.getZoom(), { animate: false }));

        return { applied: true };
      }
      case 'preserve': {
        return { applied: true };
      }
    }
  }

  private syncVisibleTrackOverlays(map: LeafletMap, nextSettings: CommonMapSettings): void {
    const nextVisibility = nextSettings.trackVisibility;

    if (!nextVisibility) return;
    const visibleTracks = this.getVisibleTracks(map);
    const manager = getMapProviderState<LeafletMapState>(map.getContainer(), LEAFLET_PROVIDER_STATE_ID)?.clustering?.manager;
    let admitted: Set<string> | undefined;

    if (manager?.isClustering()) {
      admitted = new Set();
    } else if (manager || !nextVisibility.isSingleTrackView) {
      const bounds = map.getBounds();
      const candidates = collectViewportTrackCandidates(nextVisibility.placeStates
        .filter(state => !manager || state.place.markerEnabled === false).map(state => state.place));

      admitted = manager?.getVisiblePlaceIds() ?? new Set();

      for (const candidate of selectViewportTracks(candidates, {
        minLng: bounds.getWest(), maxLng: bounds.getEast(), minLat: bounds.getSouth(), maxLat: bounds.getNorth(),
      }, { isActive: candidate => visibleTracks.has(candidate.placeId) }).desired) admitted.add(candidate.placeId);
    }

    syncVisibleTrackEntries(visibleTracks, nextVisibility, nextSettings, {
      isVisible: state => (!admitted || admitted.has(state.placeId)) && (this.trackToggles.get(map)?.get(state.placeId) ?? state.showOnLoad),
      remove: (_placeId, entry) => entry.trackLayers.forEach(trackLayer => trackLayer.removeFrom(map)),
      add: state => {
        const trackLayers: Layer[] = [];

        this.addTrackToMap(map, state.place, state.style, nextSettings.trackColorBy, nextSettings.trackGradeWindow, trackLayers, state.outline, nextSettings.trackSpeedWindow);
        visibleTracks.set(state.placeId, { place: state.place, settings: nextSettings, trackLayers, renderSignature: getTrackRenderSignature(state.place, nextVisibility) });
      },
    });
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

  private createOverlayPopup(map: LeafletMap, feature: PlacesGeoJsonFeature): HTMLElement {
    const request = getMapProviderState<LeafletMapState>(map.getContainer(), LEAFLET_PROVIDER_STATE_ID)?.runtime;
    const { sourcePath, overlay } = resolveOverlayPointSource(feature.properties || {}, request?.overlays ?? []);

    return buildOverlayPointPopup({
      app: this.app,
      feature,
      sourcePath,
      popupConfig: overlay?.popup,
      markdownSourcePath: request?.source.path,
      popupRenderers: request?.popupRenderers,
    });
  }

  setGeocodingSearchMarkers(places: MapPlace[], container: HTMLElement): void {
    const mapState = getMapProviderState<LeafletMapState>(container, LEAFLET_PROVIDER_STATE_ID);

    if (!mapState) return;
    const { map } = mapState;

    setSearchResultMarkers({
      container,
      places,
      focus: { enter: () => container.addClass('places-focus-mode'), clear: () => container.removeClass('places-focus-mode') },
      createMarker: (place, element) => {
        element.addClass('leaflet-marker-icon-container');
        element.querySelector('.places-marker-icon')?.addClass('leaflet-marker-icon-emoji');

        return new Marker([place.latitude, place.longitude], {
          icon: new DivIcon({
            className: 'leaflet-marker-icon',
            html: element,
            iconSize: [120, MarkerConstants.desktop.containerSize],
            iconAnchor: getIconAnchor('desktop'),
            popupAnchor: getPopupAnchor('desktop')
          })
        }).addTo(map);
      },
      onMarkerClick: place => {
        new Popup({ className: 'places-popup', trackResize: true, offset: getPopupAnchor('desktop') })
          .setLatLng([place.latitude, place.longitude])
          .setContent(buildGeocodingSearchPopupContent(place, mapState.settings.onPlaceAction, () => map.closePopup()))
          .openOn(map);
      },
    });
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

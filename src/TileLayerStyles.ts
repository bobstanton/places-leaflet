export interface TileLayerStyle {
  name: string;
  url: string;
  attribution: string;
  maxZoom: number;
}

export interface TileLayerStyles {
  [key: string]: TileLayerStyle;
}

export const DEFAULT_LEAFLET_TILE_STYLE = "cartodb-voyager";

export const LEAFLET_TILE_STYLES: TileLayerStyles = {
  "openstreetmap": {
    name: "OpenStreetMap",
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: `&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>`,
    maxZoom: 19  // OSM standard tiles go to 19
  },
  "opentopomap": {
    name: "OpenTopoMap",
    url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    attribution: `&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>, <a href="http://viewfinderpanoramas.org">SRTM</a> | &copy; <a href="https://opentopomap.org">OpenTopoMap</a>`,
    maxZoom: 17  // OpenTopoMap only goes to zoom 17
  },
  "cartodb-voyager": {
    name: "CartoDB Voyager",
    url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
    attribution: `&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>`,
    maxZoom: 20  // CartoDB supports zoom 20
  },
  "cartodb-positron": {
    name: "CartoDB Positron",
    url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
    attribution: `&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>`,
    maxZoom: 20  // CartoDB supports zoom 20
  },
  "cartodb-darkmatter": {
    name: "CartoDB Dark Matter",
    url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    attribution: `&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>`,
    maxZoom: 20  // CartoDB supports zoom 20
  },
  "esri-satellite": {
    name: "Esri World Imagery",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: `Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community`,
    maxZoom: 19  // Esri satellite typically goes to 19
  },
  "custom": {
    name: "Custom (use settings below)",
    url: "",
    attribution: "",
    maxZoom: 19  // Default for custom tiles
  }
};

// @param styleName A style name key, or a custom tile URL (http/https)
export function getTileLayerConfig(styleName: string | undefined, fallbackUrl?: string, fallbackAttribution?: string): { url: string; attribution: string; maxZoom: number } {
  const selectedStyle = styleName || DEFAULT_LEAFLET_TILE_STYLE;

  if (selectedStyle.startsWith('http://') || selectedStyle.startsWith('https://')) {
    return {
      url: selectedStyle,
      attribution: 'Custom Tile Server',
      maxZoom: 19
    };
  }

  if (selectedStyle === "custom") {
    const defaultStyle = LEAFLET_TILE_STYLES[DEFAULT_LEAFLET_TILE_STYLE];
    return {
      url: fallbackUrl || defaultStyle.url,
      attribution: fallbackAttribution || defaultStyle.attribution,
      maxZoom: defaultStyle.maxZoom
    };
  }

  if (LEAFLET_TILE_STYLES[selectedStyle]) {
    const style = LEAFLET_TILE_STYLES[selectedStyle];
    return {
      url: style.url,
      attribution: style.attribution,
      maxZoom: style.maxZoom
    };
  }

  throw new Error(`Unknown Leaflet map style "${selectedStyle}".`);
}

import { App, Plugin } from "obsidian";
import { IPlaceExtensionSettings, IPlacesExtensionHostSettings } from "places-shared/settings";
import { IPlacePluginExtension, IPlacePluginExtensionExports, registerPlaceExtensionLifecycle, PLACES_EXTENSION_API_VERSION, type ExtensionSettingsGroup } from "places-shared/services";
import { scalarToString, Utilities, configureRequestLogging } from "places-shared/utils";
import { LeafletMapBlockProcessor } from "./LeafletMapBlockProcessor";
import { DEFAULT_LEAFLET_TILE_STYLE, LEAFLET_TILE_STYLES } from "./TileLayerStyles";
import "./styles.css";
import "places-shared/error-styles.css";

export default class LeafletPluginExtension extends Plugin implements IPlacePluginExtension {

  onload() {
    registerPlaceExtensionLifecycle(this);
  }

  getPlaceExports(app: App, extensionSettings: IPlaceExtensionSettings, mainSettings: IPlacesExtensionHostSettings): IPlacePluginExtensionExports {
    configureRequestLogging(mainSettings.developerMode);
    Utilities.applyDefaults(extensionSettings, DEFAULT_SETTINGS);

    const mapBlockProcessor = new LeafletMapBlockProcessor(app, extensionSettings, mainSettings.units, mainSettings.developerMode);

    return {
      apiVersion: PLACES_EXTENSION_API_VERSION,
      providers: [
        {
          name: "leaflet",
          mapDefaults: { style: extensionSettings.defaultStyle },
          styles: Object.keys(LEAFLET_TILE_STYLES),
          features: {
            raster: true,
            tileCache: true
          },
          map: mapBlockProcessor
        }
      ],
      settingsGroup: this.settingsGroup(extensionSettings)
    };
  }

  private settingsGroup(settings: IPlaceExtensionSettings): ExtensionSettingsGroup {
    return {
      heading: "Leaflet map",
      items: [
        {
          name: "Default map style",
          desc: "Choose a predefined tile layer style or use custom settings below",
          control: {
            type: "dropdown",
            key: "defaultStyle",
            options: Object.fromEntries(Object.entries(LEAFLET_TILE_STYLES).map(([key, style]) => [key, style.name])),
          },
        },
        {
          name: "XYZ raster tile provider URL",
          desc: "URL template for tiles. Use {z}/{x}/{y} for zoom/coordinates. For subdomains, use {s}. Example: https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
          visible: () => settings.defaultStyle === "custom",
          control: { type: "text", key: "tileLayerUrl" },
        },
        {
          name: "Raster tile provider attribution",
          visible: () => settings.defaultStyle === "custom",
          control: { type: "text", key: "tileLayerAttribution" },
        },
      ],
      setValue: (key, value) => {
        const text = scalarToString(value);
        settings[key] = text;
        // Choosing a predefined style also fills the custom tile fields it stands for.
        if (key === "defaultStyle" && text !== "custom" && LEAFLET_TILE_STYLES[text]) {
          settings.tileLayerUrl = LEAFLET_TILE_STYLES[text].url;
          settings.tileLayerAttribution = LEAFLET_TILE_STYLES[text].attribution;
        }
      },
      updateOn: ["defaultStyle"],
    };
  }

}

const DEFAULT_SETTINGS: IPlaceExtensionSettings = {
  tileLayerUrl: LEAFLET_TILE_STYLES[DEFAULT_LEAFLET_TILE_STYLE].url,
  tileLayerAttribution: LEAFLET_TILE_STYLES[DEFAULT_LEAFLET_TILE_STYLE].attribution,
  defaultStyle: DEFAULT_LEAFLET_TILE_STYLE
};

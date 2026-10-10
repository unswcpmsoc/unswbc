import { mount } from "svelte";
import App from "./App.svelte";
import MapApp from "./MapApp.svelte";
import "./theme.css";

const target = document.getElementById("app")!;
mount(target.dataset.view === "map" ? MapApp : App, { target });

/**
 * Three.js preview: primary mode is a tilted plane with the same 2D map texture (reliable).
 * Optional voxel mode (gzip mesh) kept for advanced use.
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

let activeCleanup = null;

function emitPreview3dFirstFrame(kind) {
  try {
    window.dispatchEvent(new CustomEvent("arnis-preview3d-first-frame", { detail: { kind } }));
  } catch {
    // ignore
  }
}

/**
 * Load image from data URL (same PNG as 2D tab).
 * @param {string} dataUrl
 * @returns {Promise<HTMLImageElement>}
 */
function loadImageElement(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load map image for 3D preview"));
    img.src = dataUrl;
  });
}

/**
 * Reliable size when the 3D pane was just shown (clientWidth is often 0 before layout).
 * @param {HTMLCanvasElement} canvas
 * @returns {{ w: number, h: number }}
 */
function measureCanvas(canvas) {
  const parent = canvas.parentElement;
  const rect = canvas.getBoundingClientRect();
  const rw = rect.width;
  const rh = rect.height;
  const pw = parent ? parent.getBoundingClientRect().width : 0;
  const w = Math.max(rw, canvas.offsetWidth, pw, 520);
  const h = Math.max(rh, canvas.offsetHeight, 320);
  return { w: Math.floor(w), h: Math.floor(h) };
}

/**
 * Subdivided plane with Z displacement from map luminance (pseudo-height; not real block Y).
 * Centers the heightfield so the orbit target stays near the terrain middle.
 */
function buildHeightfieldFromMapImage(img, planeW, planeH) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;

  const canvas = document.createElement("canvas");
  canvas.width = iw;
  canvas.height = ih;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    return new THREE.PlaneGeometry(planeW, planeH);
  }
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, iw, ih).data;

  const segX = Math.min(256, Math.max(48, Math.floor(iw / 12)));
  const segY = Math.min(256, Math.max(48, Math.floor(ih / 12)));

  const geometry = new THREE.PlaneGeometry(planeW, planeH, segX, segY);
  const pos = geometry.attributes.position;
  const uv = geometry.attributes.uv;

  const span = Math.max(planeW, planeH);
  const heightScale = span * 0.11;

  /** @type {number[]} */
  const heights = [];
  for (let i = 0; i < pos.count; i++) {
    const u = uv.getX(i);
    const v = uv.getY(i);
    const px = Math.min(Math.floor(u * (iw - 1)), iw - 1);
    const py = Math.min(Math.floor((1 - v) * (ih - 1)), ih - 1);
    const idx = (py * iw + px) * 4;
    const r = imageData[idx];
    const g = imageData[idx + 1];
    const b = imageData[idx + 2];
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    const h = Math.pow(Math.max(lum, 0), 0.62) * heightScale;
    heights.push(h);
  }

  const mean = heights.reduce((a, b) => a + b, 0) / Math.max(heights.length, 1);
  for (let i = 0; i < pos.count; i++) {
    pos.setZ(i, heights[i] - mean);
  }
  pos.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Reliable 3D-style preview: the generated top-down map on a plane, orbit controls.
 * Same pixels as the 2D tab — avoids fragile million-triangle voxel meshes in WebGL.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {{ image_base64: string }} mapData — from `gui_get_world_map_data`
 * @returns {Promise<void>}
 */
export async function runPreview3dMapPlane(canvas, mapData) {
  disposePreview3d();

  if (THREE.ColorManagement) {
    THREE.ColorManagement.enabled = false;
  }

  await new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });

  const dataUrl = mapData.image_base64;
  if (!dataUrl || typeof dataUrl !== "string") {
    throw new Error("Missing map image for 3D preview");
  }

  const img = await loadImageElement(dataUrl);
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;

  const texture = new THREE.Texture(img);
  texture.needsUpdate = true;
  // NPOT (non-power-of-two) PNG sizes are normal for map screenshots. Mipmaps are invalid for NPOT
  // in WebGL1 and can make the texture render black — use linear sampling only.
  const isPot = (n) => n > 0 && (n & (n - 1)) === 0;
  const allowMipmaps = isPot(iw) && isPot(ih);
  texture.generateMipmaps = allowMipmaps;
  texture.minFilter = allowMipmaps
    ? THREE.LinearMipmapLinearFilter
    : THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.flipY = true;

  const planeW = 1000;
  const planeH = (1000 * ih) / Math.max(iw, 1);

  const geometry = buildHeightfieldFromMapImage(img, planeW, planeH);
  const material = new THREE.MeshStandardMaterial({
    map: texture,
    side: THREE.DoubleSide,
    roughness: 0.88,
    metalness: 0.04,
    flatShading: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = -Math.PI / 2;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x3a3a3a);

  const span = Math.max(planeW, planeH);
  const ambient = new THREE.AmbientLight(0xffffff, 0.42);
  const dir = new THREE.DirectionalLight(0xffffff, 0.85);
  dir.position.set(span * 0.45, span * 1.15, span * 0.5);
  scene.add(ambient, dir);
  scene.add(mesh);

  const center = new THREE.Vector3(0, 0, 0);
  const { w, h } = measureCanvas(canvas);
  const aspect = Math.max(w / Math.max(h, 1), 0.01);
  const dist = span * 0.85;

  const camera = new THREE.PerspectiveCamera(50, aspect, 0.1, 1e7);
  camera.position.set(dist * 0.55, dist * 0.72, dist * 0.55);
  camera.lookAt(center);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h, false);
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.toneMappingExposure = 1;

  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(center);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minPolarAngle = 0.08;
  controls.maxPolarAngle = Math.PI * 0.48;
  controls.minDistance = Math.max(span * 0.12, 40);
  controls.maxDistance = span * 12;
  controls.update();

  let frameId = 0;
  let didFirstFrame = false;
  function animate() {
    frameId = requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
    if (!didFirstFrame) {
      didFirstFrame = true;
      emitPreview3dFirstFrame("map");
    }
  }
  animate();

  const onResize = () => {
    const { w: cw, h: ch } = measureCanvas(canvas);
    camera.aspect = Math.max(cw / Math.max(ch, 1), 0.01);
    camera.updateProjectionMatrix();
    renderer.setSize(cw, ch, false);
  };
  window.addEventListener("resize", onResize);

  activeCleanup = () => {
    cancelAnimationFrame(frameId);
    window.removeEventListener("resize", onResize);
    controls.dispose();
    geometry.dispose();
    material.dispose();
    texture.dispose();
    renderer.dispose();
    activeCleanup = null;
  };
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {string} gzipBase64
 * @returns {Promise<void>}
 */
export async function runPreview3d(canvas, gzipBase64) {
  return runPreview3dWithOptions(canvas, gzipBase64, { quality: "medium" });
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {string} gzipBase64
 * @param {{quality?: 'low'|'medium'|'high'}} opts
 * @returns {Promise<void>}
 */
export async function runPreview3dWithOptions(canvas, gzipBase64, opts = {}) {
  disposePreview3d();
  const quality = opts.quality || "medium";

  // r150+ color management + default ACES tone mapping can crush unlit MeshBasicMaterial
  // vertex colors to black; disable for this simple preview.
  if (THREE.ColorManagement) {
    THREE.ColorManagement.enabled = false;
  }

  // Wait for layout so canvas has non-zero dimensions (otherwise aspect = NaN → black frame).
  await new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });

  const binary = Uint8Array.from(atob(gzipBase64), (c) => c.charCodeAt(0));
  const stream = new Blob([binary]).stream().pipeThrough(new DecompressionStream("gzip"));
  const buf = await new Response(stream).arrayBuffer();

  const view = new DataView(buf);
  let o = 0;
  const n = view.getUint32(o, true);
  o += 4;
  if (n === 0 || n > 50_000_000) {
    throw new Error("Invalid mesh data");
  }
  // Hard cap: beyond this, browsers often lose the WebGL context or depth buffer fails → black canvas.
  const maxVertices =
    quality === "high" ? 12_500_000 : quality === "low" ? 6_500_000 : 9_500_000;
  if (n > maxVertices) {
    throw new Error("MESH_TOO_LARGE");
  }

  const posBytes = n * 3 * 4;
  const colBytes = n * 4;
  if (o + posBytes + colBytes > buf.byteLength) {
    throw new Error("Corrupt mesh buffer");
  }

  const positions = new Float32Array(buf, o, n * 3);
  o += posBytes;
  const colorsU8 = new Uint8Array(buf, o, n * 4);

  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    colors[i * 3] = colorsU8[i * 4] / 255;
    colors[i * 3 + 1] = colorsU8[i * 4 + 1] / 255;
    colors[i * 3 + 2] = colorsU8[i * 4 + 2] / 255;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();

  const sphere = geometry.boundingSphere;
  const radius =
    sphere && sphere.radius > 0 && Number.isFinite(sphere.radius) ? sphere.radius : 100;

  // Lit PBR looks best on small meshes; huge scenes (e.g. dense cities) break depth precision or GPU
  // limits — unlit vertex colors match the old reliable path and stay visible.
  const preferUnlit =
    quality === "low" ? n > 250_000 || radius > 2_400 : n > 420_000 || radius > 3_200;
  let material;
  if (preferUnlit) {
    material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
    });
  } else {
    geometry.computeVertexNormals();
    material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      roughness: 0.93,
      metalness: 0,
      flatShading: true,
    });
  }
  const mesh = new THREE.Mesh(geometry, material);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87b8db);

  if (!preferUnlit) {
    const ambient = new THREE.AmbientLight(0xffffff, 0.42);
    const sun = new THREE.DirectionalLight(0xffffff, 0.92);
    sun.position.set(radius * 1.4, radius * 2.2, radius * 0.85);
    const fill = new THREE.HemisphereLight(0xc8e8ff, 0x6a7a88, 0.35);
    scene.add(ambient, sun, fill);
  }
  scene.add(mesh);

  const { w, h } = measureCanvas(canvas);
  const aspect = Math.max(w / Math.max(h, 1), 0.01);

  const center = sphere ? sphere.center : new THREE.Vector3();
  const dist = Math.max(radius * 2.8, 32);

  // Tighten near/far ratio — huge `far` with tiny `near` exhausts 24-bit depth and the whole mesh z-fights to black.
  const near = Math.max(0.2, Math.min(radius * 0.0025, dist * 0.02));
  const far = Math.min(Math.max(radius * 140, dist * 45, 5_000), 5e7);

  const camera = new THREE.PerspectiveCamera(50, aspect, near, far);
  camera.position.set(center.x + dist, center.y + dist * 0.45, center.z + dist);
  camera.lookAt(center);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    logarithmicDepthBuffer: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h, false);
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.toneMappingExposure = 1;

  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(center);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minPolarAngle = 0.12;
  controls.maxPolarAngle = Math.PI * 0.5;
  controls.minDistance = Math.max(radius * 0.12, 6);
  controls.maxDistance = Math.max(radius * 28, 400);
  controls.update();

  let frameId = 0;
  let didFirstFrame = false;
  function animate() {
    frameId = requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
    if (!didFirstFrame) {
      didFirstFrame = true;
      emitPreview3dFirstFrame("voxel");
    }
  }
  animate();

  const onResize = () => {
    const { w: cw, h: ch } = measureCanvas(canvas);
    camera.aspect = Math.max(cw / Math.max(ch, 1), 0.01);
    camera.updateProjectionMatrix();
    renderer.setSize(cw, ch, false);
  };
  window.addEventListener("resize", onResize);

  activeCleanup = () => {
    cancelAnimationFrame(frameId);
    window.removeEventListener("resize", onResize);
    controls.dispose();
    geometry.dispose();
    material.dispose();
    renderer.dispose();
    activeCleanup = null;
  };
}

export function disposePreview3d() {
  if (typeof activeCleanup === "function") {
    activeCleanup();
  }
}

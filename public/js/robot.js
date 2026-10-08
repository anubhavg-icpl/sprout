// Sprout 3D robot avatar — three.js + RobotExpressive.glb (CC0, Tomás Laulhé /
// Quaternius; morphs by Don McCurdy; see assets/licenses/robot-expressive-CC0.md).
//
// Contract (drop-in for the retired 2D rig in rig.js):
//   createRobot(canvas) -> Promise<{ state, setState(name), setMouth(0..1|null),
//                                    setIntensity(0..1), setBones(bool), setBlink(bool) }>
//   States: idle | listening | thinking | talking | happy | celebrating | meditating.
//   app.js drives states from the agent lifecycle; this module never picks one.
// How states map onto the model (clip names are fixed by the GLB):
//   idle Idle · listening Idle + lean-in + slight "Surprised" · thinking Idle +
//   slow body sway · talking Yes (nodding) + "Surprised" as mouth · happy ThumbsUp
//   (once) · celebrating Dance · meditating Sitting (once, holds last frame).
//   The model has no viseme/jaw shapes: "talking" fakes the mouth with the
//   Surprised morph scaled by setMouth(). Don't look for a jaw bone.
// Don't hand-rotate the Head/Neck bones: their local axes are not x=pitch
// (a +x offset spun the head backwards). Per-state motion is applied to the
// whole model root instead, which the mixer never animates.
// Reduced motion: intensity 0 slows clips and swaps Dance for ThumbsUp.
// Look: the GLB's three materials (Main shell, Grey joints, Black eyes/brows)
// are REPLACED at load with a modern palette (see LOOK); lighting comes from a
// procedural RoomEnvironment (no HDR file) + key/rim lights, ACES tone mapping.

import * as THREE from "../vendor/three/three.module.min.js";
import { GLTFLoader } from "../vendor/three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "../vendor/three/addons/environments/RoomEnvironment.js";

const MODEL_URL = "assets/models/RobotExpressive.glb";
export const STATES = ["idle", "listening", "thinking", "talking", "happy", "celebrating", "meditating"];
// [clip, loop?] per state; one-shot clips clamp on their last frame.
const CLIPS = { idle: ["Idle", true], listening: ["Idle", true], thinking: ["Idle", true], talking: ["Yes", true], happy: ["ThumbsUp", false], celebrating: ["Dance", true], meditating: ["Sitting", false] };
const FADE_S = 0.45;
// Palette: pearl shell + graphite joints + glowing eyes in the UI accent.
const LOOK = {
  Main: { color: 0xe6ebf2, roughness: 0.36, metalness: 0.05, clearcoat: 1, clearcoatRoughness: 0.12, sheen: 0.4, sheenColor: 0xcde9ff },
  Grey: { color: 0x2b313d, roughness: 0.38, metalness: 0.7, clearcoat: 0.6, clearcoatRoughness: 0.25 },
  Black: { color: 0x0b1714, emissive: 0x2ef2c4, emissiveIntensity: 2.4, roughness: 0.2, metalness: 0 },
};
const ACCENT = 0x2ef2c4;

export async function createRobot(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.92;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.65; // full-strength room env washes the white shell flat
  scene.add(new THREE.HemisphereLight(0xffffff, 0x1a2230, 0.6));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(3, 8, 6); key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, { left: -4, right: 4, top: 6, bottom: -2 });
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x8b7bff, 2.6); rim.position.set(-5, 5, -5); scene.add(rim);
  const rim2 = new THREE.DirectionalLight(ACCENT, 1.6); rim2.position.set(5, 3, -4); scene.add(rim2);
  const ground = new THREE.Mesh(new THREE.CircleGeometry(3.2, 64), new THREE.ShadowMaterial({ opacity: 0.35 }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
  // Glowing floor ring; its pulse speed/brightness follows the state (see loop).
  const ring = new THREE.Mesh(new THREE.RingGeometry(1.55, 1.7, 96), new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.5, toneMapped: false }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.01; scene.add(ring);

  const gltf = await new GLTFLoader().loadAsync(MODEL_URL);
  const model = gltf.scene;
  const restyled = new Map();
  model.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    const name = o.material.name;
    if (!LOOK[name]) return;
    if (!restyled.has(name)) {
      const { color, emissive, sheenColor, ...rest } = LOOK[name];
      restyled.set(name, new THREE.MeshPhysicalMaterial({
        name, color: new THREE.Color(color), ...(emissive && { emissive: new THREE.Color(emissive) }),
        ...(sheenColor && { sheenColor: new THREE.Color(sheenColor) }), ...rest,
      }));
    }
    o.material = restyled.get(name); // morph targets work on any standard material in r150+
  });
  const eyes = restyled.get("Black");
  scene.add(model);
  const skeleton = new THREE.SkeletonHelper(model); skeleton.visible = false; scene.add(skeleton);

  const face = model.getObjectByName("Head_4"); // mesh carrying Angry/Surprised/Sad morphs
  const morph = (name) => face?.morphTargetDictionary?.[name];
  const SURPRISED = morph("Surprised"), SAD = morph("Sad");

  const mixer = new THREE.AnimationMixer(model);
  const actions = Object.fromEntries(gltf.animations.map((c) => [c.name, mixer.clipAction(c)]));
  for (const [clip, loop] of Object.values(CLIPS)) {
    const a = actions[clip]; if (!loop) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
  }

  let state = "idle", intensity = 0.7, mouth = null, current = null, t = 0;
  let surprised = 0, sad = 0;
  function play(clip) {
    const next = actions[clip]; if (!next || next === current) return;
    next.reset().setEffectiveWeight(1).fadeIn(FADE_S).play();
    current?.fadeOut(FADE_S);
    current = next;
  }
  // One-shot clips (Wave greeting, ThumbsUp) fall back to Idle when done;
  // Sitting stays clamped so the robot keeps "meditating" until woken.
  mixer.addEventListener("finished", (e) => { if (e.action === current && state !== "meditating") { current = null; play("Idle"); } });
  actions.Wave.setLoop(THREE.LoopOnce, 1);
  play("Wave"); // friendly hello on load

  // Frame from the model's real bounds (bind pose) instead of magic numbers;
  // HEADROOM leaves space above for jumps/Dance arms and the stage label.
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
  const HEADROOM = 1.55;
  const resize = () => {
    const { width, height } = canvas.getBoundingClientRect();
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    const vFov = THREE.MathUtils.degToRad(camera.fov);
    const fitH = (size.y * HEADROOM) / 2 / Math.tan(vFov / 2);
    const fitW = (Math.max(size.x, size.z) * 1.9) / 2 / Math.tan(vFov / 2) / camera.aspect;
    const dist = Math.max(fitH, fitW);
    camera.position.set(0, center.y + size.y * 0.12, dist);
    camera.lookAt(0, center.y + size.y * 0.08, 0);
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(canvas); resize();

  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.05); t += dt;
    mixer.timeScale = intensity === 0 ? 0.45 : 0.7 + intensity * 0.45;
    mixer.update(dt);
    const sway = intensity;
    // Ease face morphs toward their targets for the current state.
    const wantS = state === "talking" ? (mouth ?? Math.abs(Math.sin(t * 9))) * 0.85 : state === "listening" ? 0.25 : state === "celebrating" ? 0.5 : 0;
    surprised += (wantS - surprised) * Math.min(1, dt * 18);
    sad += ((state === "meditating" ? 0.15 : 0) - sad) * Math.min(1, dt * 6);
    if (face && SURPRISED != null) face.morphTargetInfluences[SURPRISED] = surprised;
    if (face && SAD != null) face.morphTargetInfluences[SAD] = sad;
    // Whole-body acting on the root (smoothed so state changes never snap).
    const k = Math.min(1, dt * 4);
    const wantY = state === "thinking" ? Math.sin(t * 0.6) * 0.35 * sway + 0.15 : 0;
    const wantX = state === "listening" ? 0.08 : 0;
    const wantZ = state === "thinking" ? 0.05 : 0;
    model.rotation.y += (wantY - model.rotation.y) * k;
    model.rotation.x += (wantX - model.rotation.x) * k;
    model.rotation.z += (wantZ - model.rotation.z) * k;
    // Eyes + ring "breathe"; busier states glow faster and brighter.
    const busy = state === "thinking" || state === "talking" || state === "celebrating";
    const pulse = 0.5 + 0.5 * Math.sin(t * (busy ? 5 : 1.6));
    if (eyes) eyes.emissiveIntensity = 1.8 + pulse * (busy ? 1.6 : 0.6) + (state === "talking" ? (mouth ?? 0) * 1.2 : 0);
    ring.material.opacity = (state === "meditating" ? 0.25 : 0.3) + pulse * (busy ? 0.45 : 0.2);
    ring.scale.setScalar(1 + pulse * (busy ? 0.06 : 0.02));
    renderer.render(scene, camera);
  });

  return {
    get state() { return state; },
    setState(next) {
      if (!STATES.includes(next) || next === state) return;
      state = next;
      let [clip] = CLIPS[next];
      if (next === "celebrating" && intensity === 0) clip = "ThumbsUp";
      play(clip);
    },
    setMouth(v) { mouth = v === null ? null : Math.max(0, Math.min(1, v)); },
    setIntensity(v) { intensity = v; },
    setBones(v) { skeleton.visible = v; },
    setBlink() { /* model has no eyelids — kept for API parity with the 2D rig */ },
  };
}

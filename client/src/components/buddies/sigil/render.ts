// Buddy sigil renderer: genome → 144px PNG blob. Runs in sigil.worker.ts, never on
// the main thread (OffscreenCanvas only; see the worker for why).
//
// Two layers, one field:
//   1. A WebGL2 fragment shader evaluates a scalar field t(p) ∈ [0, 1] — a
//      weighted blend of a CPPN, rings, fbm noise and bands after symmetry
//      folding and domain warp — and colours it through a palette LUT with
//      continuous posterization and contour lines OUTSIDE the figure. Inside,
//      an almost-solid silhouette carries a second, faded field.
//   2. Canvas 2D brush strokes steered by the SAME field: pass 0 writes t and
//      the mask into the framebuffer, we read it back, and strokes follow its
//      gradient or contours. Nothing about the field is duplicated in JS.
//
// The palette is built once in JS (OKLCH → sRGB) and uploaded as a 256×1
// texture, so the shader and the strokes share one colour definition.
//
// Workspace emblems (emblem.ts) reuse the same field and colouring with a
// second fragment `main`: dark ground, the pattern glowing inside a
// superformula kernel. Two programs, one context.
//
// Rendering is ~ms on the GPU; results are cached by name (see BuddySigil).
// One shared WebGL context serves every sigil — browsers cap live contexts
// at ~16, so a context per avatar would start evicting after one screenful.

import { EMBLEM_EDGE_OPACITY, type EmblemGenome } from './emblem';
import type { SigilGenome } from './genome';

export const SIGIL_SIZE = 144;
const GL_SIZE = SIGIL_SIZE * 2; // rendered 2× and downsampled for antialiasing
const LUT_SIZE = 256;

const VERTEX = `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

// Shared by both programs: the scalar field and how it is coloured.
const FIELD = `#version 300 es
precision highp float;
uniform vec2 u_res;
uniform sampler2D u_palette;
uniform vec3 u_ink;
uniform vec4 u_frame;        // zoom, centerX, centerY, rotation
uniform vec4 u_sym;          // order, amount, mirror, -
uniform vec4 u_warp;         // amount, frequency, offsetX, offsetY
uniform vec4 u_mix;          // cppn, rings, noise, bands (outer pattern)
uniform vec4 u_rings;        // frequency, phase, centerX, centerY
uniform vec4 u_bands;        // frequency, angle, noiseFrequency, gain
uniform vec4 u_post;         // amount, levels, softness, -
uniform vec4 u_contour;      // width px, count, -, -
uniform vec4 u_mask;         // -, radius, exponent, softness
uniform vec4 u_maskShape;    // aspect, warp, warpFrequency, warpPhase
uniform vec4 u_finish;       // grain, vignette, seed, -
uniform vec4 u_w1[12];       // input i → neurons 0-3 at [2i], 4-7 at [2i+1]
uniform vec4 u_w2[18];       // hidden j (and bias j = 8) likewise
uniform vec4 u_w3[2];
uniform float u_w3bias;
uniform vec4 u_act[2];
uniform float u_actFreq;
out vec4 outColor;

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.3); a *= 0.5; }
  return s / 0.9375;
}
vec2 rot(vec2 p, float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c) * p; }
float superellipse(vec2 p, float n) { vec2 a = abs(p) + 1e-6; return pow(pow(a.x, n) + pow(a.y, n), 1.0 / n); }
vec4 act(vec4 u, vec4 m) { return mix(sin(u * u_actFreq), tanh(u), m); }

float cppn(vec2 p, float r, float d, float n) {
  float x[6] = float[6](p.x, p.y, r, d, (n * 2.0 - 1.0) * 0.5, 1.0);
  vec4 ha = vec4(0.0), hb = vec4(0.0);
  for (int i = 0; i < 6; i++) { ha += x[i] * u_w1[2 * i]; hb += x[i] * u_w1[2 * i + 1]; }
  ha = act(ha, u_act[0]); hb = act(hb, u_act[1]);
  float h[9] = float[9](ha.x, ha.y, ha.z, ha.w, hb.x, hb.y, hb.z, hb.w, 1.0);
  vec4 ga = vec4(0.0), gb = vec4(0.0);
  for (int j = 0; j < 9; j++) { ga += h[j] * u_w2[2 * j]; gb += h[j] * u_w2[2 * j + 1]; }
  ga = act(ga, u_act[0].wzyx); gb = act(gb, u_act[1].wzyx);
  return tanh(dot(ga, u_w3[0]) + dot(gb, u_w3[1]) + u_w3bias);
}

vec2 fold(vec2 p, float k, float mirror) {
  float seg = 6.2831853 / k;
  float a = atan(p.y, p.x);
  float af = mod(a + seg * 0.5, seg) - seg * 0.5;
  af = mix(af, abs(af), mirror);
  return length(p) * vec2(cos(af), sin(af));
}

float field(vec2 p0, float k, vec4 w) {
  vec2 p = mix(p0, fold(p0, k, u_sym.z), u_sym.y);
  p += u_warp.x * (vec2(fbm(p * u_warp.y + u_warp.zw), fbm(p * u_warp.y + u_warp.wz + 5.2)) - 0.5) * 2.0;
  float n = fbm(p * u_bands.z + 3.7);
  float c = cppn(p, length(p), superellipse(p * vec2(1.0 / u_maskShape.x, u_maskShape.x), u_mask.z), n);
  float rings = sin(length(p - u_rings.zw) * u_rings.x + u_rings.y);
  float bands = sin(dot(p, vec2(cos(u_bands.y), sin(u_bands.y))) * u_bands.x);
  float f = w.x * c + w.y * rings + w.z * (n * 2.0 - 1.0) * 1.6 + w.w * bands;
  return 0.5 + 0.5 * tanh(u_bands.w * f);
}

// Seamless noise around the unit circle: sampling on (cos θ, sin θ) closes
// the loop, so the warped outline never shows a seam at θ = ±π.
float radialNoise(float theta, float frequency, float phase) {
  vec2 c = vec2(cos(theta), sin(theta)) * frequency + phase;
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) { s += a * vnoise(c); c = c * 2.1 + 7.3; a *= 0.45; }
  return s / 0.7 * 2.0 - 1.0;
}

// Symmetry order is continuous: crossfade the two neighbouring integer folds.
float fieldAt(vec2 p, vec4 w) {
  float k0 = floor(u_sym.x);
  float blend = smoothstep(0.35, 0.65, fract(u_sym.x));
  return mix(field(p, k0, w), field(p, k0 + 1.0, w), blend);
}

// Palette colour of field value t: continuous posterization, then contours.
vec3 patternColor(float t) {
  float x = t * u_post.y;
  float soft = max(u_post.z, fwidth(x));
  float stepped = (floor(x) + smoothstep(0.5 - soft, 0.5 + soft, fract(x))) / u_post.y;
  float tq = clamp(mix(t, stepped, u_post.x), 0.0, 1.0);
  vec3 col = texture(u_palette, vec2(tq, 0.5)).rgb;

  float cx = t * u_contour.y;
  float fc = fract(cx);
  float px = min(fc, 1.0 - fc) / max(fwidth(cx), 1e-5);
  float line = 1.0 - clamp(px - u_contour.x * 0.5, 0.0, 1.0);
  return mix(col, u_ink, line * step(0.01, u_contour.x));
}
`;

// Buddy sigil: the pattern around an almost-solid silhouette.
const SIGIL_MAIN = `
uniform int u_mode;          // 0 = field readback, 1 = colour
uniform vec4 u_innerMix;     // same as u_mix, inner pattern
uniform vec4 u_innerFrame;   // zoom, offsetX, offsetY, rotation
uniform vec4 u_fill;         // silhouette rgb, inner pattern strength
uniform vec2 u_profile;      // angle, bias

// Central figure: a superellipse whose aspect and squareness move together
// (tall rectangle ↔ wide oval), its radius modulated by radial noise weighted
// toward the profile side. Returns coverage in [0, 1].
float figureMask(vec2 q) {
  float d = superellipse(q * vec2(1.0 / u_maskShape.x, u_maskShape.x), u_mask.z);
  float theta = atan(q.y, q.x);
  float side = smoothstep(-0.3, 1.0, cos(theta - u_profile.x));
  float weight = mix(1.0, side, u_profile.y);
  float radius = u_mask.y * (1.0 + u_maskShape.y * weight * radialNoise(theta, u_maskShape.z, u_maskShape.w));
  float aa = fwidth(d);
  return 1.0 - smoothstep(radius - u_mask.w - aa, radius + u_mask.w + aa, d);
}

void main() {
  vec2 q = (gl_FragCoord.xy / u_res - 0.5) * 2.0;
  vec2 p = rot((q - u_frame.yz) * u_frame.x, u_frame.w);
  float t = fieldAt(p, u_mix);
  float figure = figureMask(q);

  if (u_mode == 0) {
    float e = floor(t * 65535.0);
    outColor = vec4(floor(e / 256.0) / 255.0, mod(e, 256.0) / 255.0, figure, 1.0);
    return;
  }

  vec3 col = patternColor(t);
  vec2 pi = rot((q - u_innerFrame.yz) * u_innerFrame.x, u_innerFrame.w);
  vec3 innerPattern = texture(u_palette, vec2(fieldAt(pi, u_innerMix), 0.5)).rgb;
  vec3 silhouette = mix(u_fill.rgb, innerPattern, u_fill.w);
  col = mix(col, silhouette, figure);
  col *= 1.0 - u_finish.y * dot(q, q) * 0.35;
  col += (hash(gl_FragCoord.xy + u_finish.z) - 0.5) * u_finish.x;
  outColor = vec4(col, 1.0);
}`;

// Workspace emblem (sigil/emblem.ts): the inverse. A dark ground, the pattern
// at full strength inside a superformula kernel, fading to the edge opacity.
const EMBLEM_MAIN = `
uniform vec3 u_ground;
uniform vec4 u_kernel;       // lobes, n1, n2, n3
uniform vec2 u_kernelScale;  // 1 / max radius at floor(lobes) and floor(lobes) + 1
uniform vec4 u_kernelShape;  // radius, softness, rotation, edge opacity
uniform vec3 u_kernelWarp;   // amount, frequency, phase

float superformula(float theta, float m) {
  float a = pow(abs(cos(m * theta / 4.0)), u_kernel.z);
  float b = pow(abs(sin(m * theta / 4.0)), u_kernel.w);
  return pow(a + b + 1e-6, -1.0 / u_kernel.y);
}

// Lobe count is continuous: crossfade the two neighbouring integer shapes,
// each normalised to the same outer radius.
float kernelRadius(float theta) {
  float m0 = floor(u_kernel.x);
  float blend = smoothstep(0.35, 0.65, fract(u_kernel.x));
  float r = mix(superformula(theta, m0) * u_kernelScale.x,
                superformula(theta, m0 + 1.0) * u_kernelScale.y, blend);
  float wobble = 1.0 + u_kernelWarp.x * radialNoise(theta, u_kernelWarp.y, u_kernelWarp.z);
  return u_kernelShape.x * r * wobble;
}

void main() {
  vec2 q = (gl_FragCoord.xy / u_res - 0.5) * 2.0;
  vec2 p = rot((q - u_frame.yz) * u_frame.x, u_frame.w);
  vec3 pattern = patternColor(fieldAt(p, u_mix));

  vec2 k = rot(q, u_kernelShape.z);
  float d = length(q) / max(kernelRadius(atan(k.y, k.x)), 1e-3);
  float core = 1.0 - smoothstep(1.0 - u_kernelShape.y, 1.0 + u_kernelShape.y, d);
  float heart = 1.0 - 0.3 * smoothstep(0.0, 1.0, d);
  float glow = 0.4 * exp(-4.0 * max(d - 1.0, 0.0));
  float halo = u_kernelShape.w * (1.0 - smoothstep(0.35, 1.4, length(q)));
  vec3 col = mix(u_ground, pattern, max(core * heart, max(glow, halo)));
  col += (hash(gl_FragCoord.xy + u_finish.z) - 0.5) * u_finish.x;
  outColor = vec4(col, 1.0);
}`;

// =============================================================================
// Colour: OKLCH → sRGB bytes, shared by the LUT, ground, ink and strokes.
// =============================================================================
type Rgb = readonly [number, number, number]; // 0..1 sRGB

function oklchToRgb(l: number, c: number, hueDegrees: number): Rgb {
  const h = (hueDegrees * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  const [r, g, bl] = linear.map((v) => {
    const x = Math.min(1, Math.max(0, v));
    return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
  });
  return [r, g, bl];
}

function paletteRgb(genome: SigilGenome, t: number): Rgb {
  const p = genome.palette;
  const hue = p.hue + p.spread * (t - 0.5) + p.curve * 60 * Math.sin(Math.PI * t);
  const lightness = p.lightLow + (p.lightHigh - p.lightLow) * t;
  // Polarity flips ink lightness for light-ground pieces, continuously.
  const l = lightness + (1.15 - 2 * lightness) * p.polarity;
  const c = Math.max(0, p.chroma * (1 + p.chromaMid * Math.sin(Math.PI * t)));
  return oklchToRgb(l, c, hue);
}

function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function paletteLut(genome: SigilGenome): Uint8Array {
  const lut = new Uint8Array(LUT_SIZE * 4);
  for (let i = 0; i < LUT_SIZE; i++) {
    const [r, g, b] = paletteRgb(genome, i / (LUT_SIZE - 1));
    lut.set([r * 255, g * 255, b * 255, 255], i * 4);
  }
  return lut;
}

// =============================================================================
// GPU: one lazily created context + program shared by every sigil.
// =============================================================================
type ProgramKind = 'sigil' | 'emblem';

const FRAGMENTS: Record<ProgramKind, string> = {
  sigil: FIELD + SIGIL_MAIN,
  emblem: FIELD + EMBLEM_MAIN,
};

type Program = { program: WebGLProgram; uniforms: Map<string, WebGLUniformLocation> };

type Gpu = {
  gl: WebGL2RenderingContext;
  palette: WebGLTexture;
  programs: Map<ProgramKind, Program>;
};

let sharedGpu: Gpu | undefined;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Sigil: createShader failed');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`Sigil shader: ${gl.getShaderInfoLog(shader)}`);
  }
  return shader;
}

function createGpu(): Gpu {
  const canvas = new OffscreenCanvas(GL_SIZE, GL_SIZE);
  const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false });
  if (!gl) throw new Error('Sigil: WebGL2 is unavailable');

  // One oversized triangle covers the viewport. Both programs bind a_pos to
  // location 0, so this one vertex array serves them both.
  gl.bindVertexArray(gl.createVertexArray());
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const palette = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, palette);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.viewport(0, 0, GL_SIZE, GL_SIZE);
  return { gl, palette, programs: new Map() };
}

function link(gl: WebGL2RenderingContext, fragment: string): Program {
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragment));
  gl.bindAttribLocation(program, 0, 'a_pos');
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`Sigil program: ${gl.getProgramInfoLog(program)}`);
  }
  const uniforms = new Map<string, WebGLUniformLocation>();
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(program, i);
    if (!info) continue;
    const name = info.name.replace(/\[0\]$/, '');
    const location = gl.getUniformLocation(program, info.name);
    if (location) uniforms.set(name, location);
  }
  return { program, uniforms };
}

/** The shared context with `kind`'s program linked (once) and in use. */
function gpu(kind: ProgramKind): {
  gl: WebGL2RenderingContext;
  palette: WebGLTexture;
  program: Program;
} {
  sharedGpu ??= createGpu();
  const { gl, palette, programs } = sharedGpu;
  const program = programs.get(kind) ?? link(gl, FRAGMENTS[kind]);
  programs.set(kind, program);
  // biome-ignore lint/correctness/useHookAtTopLevel: WebGL's gl.useProgram, not a React hook.
  gl.useProgram(program.program);
  return { gl, palette, program };
}

type Device = ReturnType<typeof gpu>;

function uniform({ program }: Device, name: string): WebGLUniformLocation {
  const location = program.uniforms.get(name);
  if (!location) throw new Error(`Sigil: missing uniform ${name}`);
  return location;
}

function uploadPalette({ gl, palette }: Device, genome: SigilGenome): void {
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, palette);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    LUT_SIZE,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    paletteLut(genome)
  );
}

/** Everything FIELD reads: the pattern, its colouring and the finish. */
function setFieldUniforms(device: Device, g: SigilGenome, ink: Rgb): void {
  const { gl } = device;
  const u = (name: string) => uniform(device, name);
  gl.uniform2f(u('u_res'), GL_SIZE, GL_SIZE);
  gl.uniform1i(u('u_palette'), 0);
  gl.uniform3f(u('u_ink'), ...ink);
  gl.uniform4f(u('u_frame'), g.frame.zoom, g.frame.centerX, g.frame.centerY, g.frame.rotation);
  gl.uniform4f(u('u_sym'), g.symmetry.order, g.symmetry.amount, g.symmetry.mirror, 0);
  gl.uniform4f(u('u_warp'), g.warp.amount, g.warp.frequency, g.warp.offsetX, g.warp.offsetY);
  gl.uniform4f(u('u_mix'), g.mix.cppn, g.mix.rings, g.mix.noise, g.mix.bands);
  gl.uniform4f(u('u_rings'), g.rings.frequency, g.rings.phase, g.rings.centerX, g.rings.centerY);
  gl.uniform4f(u('u_bands'), g.bands.frequency, g.bands.angle, g.noiseFrequency, g.gain);
  gl.uniform4f(u('u_post'), g.posterize.amount, g.posterize.levels, g.posterize.softness, 0);
  gl.uniform4f(u('u_contour'), g.contour.width, g.contour.count, 0, 0);
  // Kernel 0 → tall rectangle (narrow, squarish), 1 → wide oval (round).
  const k = g.mask.kernel;
  const aspect = 0.72 + (1.3 - 0.72) * k;
  const exponent = 6 + (2 - 6) * k;
  gl.uniform4f(u('u_mask'), 0, g.mask.radius, exponent, g.mask.softness);
  gl.uniform4f(u('u_maskShape'), aspect, g.mask.warp, g.mask.warpFrequency, g.mask.warpPhase);
  gl.uniform4f(u('u_finish'), g.finish.grain, g.finish.vignette, g.strokes.seed % 1000, 0);
  gl.uniform4fv(u('u_w1'), g.cppn.layer1);
  gl.uniform4fv(u('u_w2'), g.cppn.layer2);
  gl.uniform4fv(u('u_w3'), g.cppn.out.subarray(0, 8));
  gl.uniform1f(u('u_w3bias'), g.cppn.out[8]);
  gl.uniform4fv(u('u_act'), g.cppn.activation);
  gl.uniform1f(u('u_actFreq'), g.cppn.frequency);
}

function setSigilUniforms(device: Device, g: SigilGenome, fill: Rgb): void {
  const { gl } = device;
  const u = (name: string) => uniform(device, name);
  const im = g.inner.mix;
  gl.uniform4f(u('u_innerMix'), im.cppn, im.rings, im.noise, im.bands);
  gl.uniform4f(u('u_innerFrame'), g.inner.zoom, g.inner.offsetX, g.inner.offsetY, g.inner.rotation);
  gl.uniform4f(u('u_fill'), ...fill, g.inner.strength);
  gl.uniform2f(u('u_profile'), g.mask.profileAngle, g.mask.profileBias);
}

function setEmblemUniforms(device: Device, e: EmblemGenome): void {
  const { gl } = device;
  const u = (name: string) => uniform(device, name);
  const k = e.kernel;
  gl.uniform3f(u('u_ground'), ...oklchToRgb(e.ground.lightness, e.ground.chroma, e.ground.hue));
  gl.uniform4f(u('u_kernel'), k.lobes, k.n1, k.n2, k.n3);
  gl.uniform2f(u('u_kernelScale'), k.scale[0], k.scale[1]);
  gl.uniform4f(u('u_kernelShape'), k.radius, k.softness, k.rotation, EMBLEM_EDGE_OPACITY);
  gl.uniform3f(u('u_kernelWarp'), k.warp, k.warpFrequency, k.warpPhase);
}

type FieldSample = { t: Float32Array; figure: Float32Array };

function readField(gl: WebGL2RenderingContext): FieldSample {
  const pixels = new Uint8Array(GL_SIZE * GL_SIZE * 4);
  gl.readPixels(0, 0, GL_SIZE, GL_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  const t = new Float32Array(GL_SIZE * GL_SIZE);
  const figure = new Float32Array(GL_SIZE * GL_SIZE);
  // readPixels rows run bottom-up; store top-down to match canvas space.
  for (let row = 0; row < GL_SIZE; row++) {
    for (let col = 0; col < GL_SIZE; col++) {
      const src = ((GL_SIZE - 1 - row) * GL_SIZE + col) * 4;
      const dst = row * GL_SIZE + col;
      t[dst] = (pixels[src] * 256 + pixels[src + 1]) / 65535;
      figure[dst] = pixels[src + 2] / 255;
    }
  }
  return { t, figure };
}

// =============================================================================
// Strokes: tapered polylines traced through the field, in SIGIL_SIZE space.
// =============================================================================
function streamFor(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function drawStrokes(
  ctx: OffscreenCanvasRenderingContext2D,
  g: SigilGenome,
  field: FieldSample
): void {
  const s = g.strokes;
  const next = streamFor(s.seed);
  const scale = GL_SIZE / SIGIL_SIZE;
  const at = (grid: Float32Array, x: number, y: number) => {
    const col = Math.min(GL_SIZE - 1, Math.max(0, Math.round(x * scale)));
    const row = Math.min(GL_SIZE - 1, Math.max(0, Math.round(y * scale)));
    return grid[row * GL_SIZE + col];
  };
  const step = 1.2;
  const steps = Math.max(2, Math.round(s.length / step));
  // Gradient span in sigil px. ±1px read mostly 16-bit quantization noise on
  // low-frequency fields, which turned every stroke into a scribble.
  const span = 4;
  const steer = 40;
  const turnCos = Math.cos(s.flow * (Math.PI / 2));
  const turnSin = Math.sin(s.flow * (Math.PI / 2));
  ctx.lineCap = 'round';

  for (let i = 0; i < s.count; i++) {
    let x = next() * SIGIL_SIZE;
    let y = next() * SIGIL_SIZE;
    // Strokes belong to the outer pattern; keep the silhouette clean.
    if (next() < at(field.figure, x, y)) continue;

    const t0 = Math.min(1, Math.max(0, at(field.t, x, y) + s.colorShift));
    const base = paletteRgb(g, t0);
    const toward = s.tone > 0 ? 1 : 0;
    const amount = Math.abs(s.tone) * 0.5;
    const [r, gr, b] = base.map((v) => Math.round((v + (toward - v) * amount) * 255));
    ctx.strokeStyle = `rgba(${r}, ${gr}, ${b}, ${s.alpha.toFixed(3)})`;

    // Momentum: the heading starts on the global bias and is pulled by the
    // (rotated) field gradient in proportion to its strength, so flat regions
    // keep a coherent direction instead of jittering.
    let dx = Math.cos(s.bias);
    let dy = Math.sin(s.bias);
    for (let k = 0; k < steps; k++) {
      const gx = at(field.t, x + span, y) - at(field.t, x - span, y);
      const gy = at(field.t, x, y + span) - at(field.t, x, y - span);
      dx += (gx * turnCos - gy * turnSin) * steer;
      dy += (gx * turnSin + gy * turnCos) * steer;
      const length = Math.hypot(dx, dy);
      dx /= length;
      dy /= length;
      const nx = x + dx * step;
      const ny = y + dy * step;
      ctx.lineWidth = 0.3 + s.width * Math.sin((Math.PI * (k + 0.5)) / steps);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(nx, ny);
      ctx.stroke();
      x = nx;
      y = ny;
    }
  }
}

/** Downsample the 2× framebuffer into a SIGIL_SIZE canvas. */
function downsample(gl: WebGL2RenderingContext): {
  canvas: OffscreenCanvas;
  ctx: OffscreenCanvasRenderingContext2D;
} {
  const canvas = new OffscreenCanvas(SIGIL_SIZE, SIGIL_SIZE);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Sigil: 2D canvas is unavailable');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(gl.canvas, 0, 0, SIGIL_SIZE, SIGIL_SIZE);
  return { canvas, ctx };
}

/** Render a Buddy genome to a PNG. Worker or window (WebGL2 + OffscreenCanvas). */
export function renderSigil(genome: SigilGenome): Promise<Blob> {
  const device = gpu('sigil');
  const { gl } = device;
  const background = oklchToRgb(
    genome.background.lightness,
    genome.background.chroma,
    genome.background.hue
  );
  const ink = genome.contour.ink > 0.5 ? paletteRgb(genome, 1) : background;
  const tone = paletteRgb(genome, genome.inner.fillTone);
  const fill = mixRgb(background, tone, genome.inner.fill);

  uploadPalette(device, genome);
  setFieldUniforms(device, genome, ink);
  setSigilUniforms(device, genome, fill);

  gl.uniform1i(uniform(device, 'u_mode'), 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const field = readField(gl);
  gl.uniform1i(uniform(device, 'u_mode'), 1);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  const { canvas, ctx } = downsample(gl);
  drawStrokes(ctx, genome, field);
  return canvas.convertToBlob({ type: 'image/png' });
}

/**
 * Render a workspace emblem to a PNG. No strokes: the emblem is soft by
 * design, and strokes would draw hard lines across its fade.
 */
export function renderEmblem(emblem: EmblemGenome): Promise<Blob> {
  const device = gpu('emblem');
  const { gl } = device;
  uploadPalette(device, emblem.field);
  setFieldUniforms(device, emblem.field, paletteRgb(emblem.field, 1));
  setEmblemUniforms(device, emblem);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  return downsample(gl).canvas.convertToBlob({ type: 'image/png' });
}

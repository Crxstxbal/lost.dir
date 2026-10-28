// WebGL2 port of engine/ascii_renderer.py (grid pipeline): ASCII glyph atlas + CRT shader.
// The fragment shader is a line-by-line port of GRID_FRAGMENT_SHADER.

const VERT = `#version 300 es
in vec2 in_pos;
in vec2 in_uv;
out vec2 v_uv;
void main() {
    v_uv = in_uv;
    gl_Position = vec4(in_pos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_atlas;
uniform sampler2D u_char_map;
uniform sampler2D u_color_map;

uniform vec2 u_grid_size;
uniform vec2 u_atlas_grid;
uniform vec2 u_viewport_size;
uniform float u_time;

uniform bool u_scanlines;
uniform float u_scanline_str;
uniform float u_vignette_str;
uniform float u_grain_str;
uniform float u_aberration_str;
uniform float u_bloom_boost;
uniform float u_ambient_bg;

float hash(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233) + u_time)) * 43758.5453);
}

void main() {
    vec2 cell_coord = floor(v_uv * u_grid_size);
    vec2 cell_uv = fract(v_uv * u_grid_size);

    vec2 map_uv = (cell_coord + 0.5) / u_grid_size;
    map_uv.y = 1.0 - map_uv.y;

    float char_id = floor(texture(u_char_map, map_uv).r * 255.0 + 0.5);

    vec3 color;
    if (u_aberration_str > 0.0) {
        vec2 dist_from_center = v_uv - 0.5;
        vec2 r_offset = dist_from_center * u_aberration_str;
        vec2 b_offset = -dist_from_center * u_aberration_str;
        float r = texture(u_color_map, clamp(map_uv + r_offset, 0.0, 1.0)).r;
        float g = texture(u_color_map, map_uv).g;
        float b = texture(u_color_map, clamp(map_uv + b_offset, 0.0, 1.0)).b;
        color = vec3(r, g, b);
    } else {
        color = texture(u_color_map, map_uv).rgb;
    }

    float col = mod(char_id, u_atlas_grid.x);
    float row = floor(char_id / u_atlas_grid.x);
    vec2 glyph_uv = vec2(
        (col + cell_uv.x) / u_atlas_grid.x,
        (row + (1.0 - cell_uv.y)) / u_atlas_grid.y
    );

    float glyph_alpha = texture(u_atlas, glyph_uv).r;
    float visual_density = mix(u_ambient_bg, 1.0, glyph_alpha);
    vec3 out_col = color * visual_density * (1.0 + u_bloom_boost);

    if (u_scanlines && u_scanline_str > 0.0) {
        float scanline = sin(v_uv.y * u_viewport_size.y * 3.14159265);
        scanline = (scanline + 1.0) * 0.5;
        out_col *= (1.0 - u_scanline_str * (1.0 - scanline));
    }

    if (u_vignette_str > 0.0) {
        vec2 v = v_uv * (1.0 - v_uv.yx);
        float vig = v.x * v.y * 15.0;
        vig = clamp(pow(vig, u_vignette_str), 0.0, 1.0);
        out_col *= vig;
    }

    if (u_grain_str > 0.0) {
        float grain = (hash(v_uv * u_viewport_size) - 0.5) * u_grain_str;
        out_col += vec3(grain);
    }

    fragColor = vec4(clamp(out_col, 0.0, 1.0), 1.0);
}`;

export class ASCIIRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", { antialias: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error("WebGL2 no está disponible en este navegador");
    this.gl = gl;
    this.prog = this._program(VERT, FRAG);
    this.uniforms = {};
    this.start = performance.now();

    const quad = new Float32Array([-1, -1, 0, 0, 1, -1, 1, 0, -1, 1, 0, 1, 1, 1, 1, 1]);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    const posLoc = gl.getAttribLocation(this.prog, "in_pos");
    const uvLoc = gl.getAttribLocation(this.prog, "in_uv");
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(uvLoc);
    gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 16, 8);

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.texAtlas = this._texture(gl.LINEAR);
    this.texChar = this._texture(gl.NEAREST);
    this.texColor = this._texture(gl.NEAREST);
    this.gridSize = [0, 0];

    gl.useProgram(this.prog);
    this.set("u_atlas", 0, "1i");
    this.set("u_char_map", 1, "1i");
    this.set("u_color_map", 2, "1i");
    this.set("u_ambient_bg", 0.04);
  }

  _program(vs, fs) {
    const gl = this.gl;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }

  _texture(filter) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    return t;
  }

  /** Sets a uniform; numbers -> 1f, [a, b] -> 2f, booleans -> 1i. */
  set(name, value, kind) {
    const gl = this.gl;
    if (!(name in this.uniforms)) this.uniforms[name] = gl.getUniformLocation(this.prog, name);
    const loc = this.uniforms[name];
    if (loc === null) return;
    gl.useProgram(this.prog);
    if (kind === "1i" || typeof value === "boolean") gl.uniform1i(loc, value ? (value === true ? 1 : value) : 0);
    else if (Array.isArray(value)) gl.uniform2f(loc, value[0], value[1]);
    else gl.uniform1f(loc, value);
  }

  /** Builds the glyph atlas (16 glyphs per row), like ASCIIRenderer.update_font_atlas. */
  updateFontAtlas(ramp, fontSize) {
    const cols = 16;
    const rows = Math.ceil(ramp.length / cols);
    const font = `${fontSize}px Consolas, "DejaVu Sans Mono", Menlo, "Courier New", monospace`;
    const probe = document.createElement("canvas").getContext("2d");
    probe.font = font;
    const cellW = Math.max(Math.ceil(probe.measureText("M").width), 8);
    const cellH = Math.max(Math.ceil(fontSize * 1.2), 12);

    const cv = document.createElement("canvas");
    cv.width = cols * cellW;
    cv.height = rows * cellH;
    const ctx = cv.getContext("2d");
    ctx.font = font;
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    [...ramp].forEach((ch, i) => {
      const cx = (i % cols) * cellW + cellW / 2;
      const cy = Math.floor(i / cols) * cellH + cellH / 2;
      ctx.fillText(ch, cx, cy);
    });
    const rgba = ctx.getImageData(0, 0, cv.width, cv.height).data;
    const alpha = new Uint8Array(cv.width * cv.height);
    for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3];

    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texAtlas);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, cv.width, cv.height, 0, gl.RED, gl.UNSIGNED_BYTE, alpha);
    this.set("u_atlas_grid", [cols, rows]);
  }

  /** Uploads character indices (H*W bytes) and RGB colours (H*W*3 bytes); row 0 = top. */
  updateFrame(indices, colors, w, h) {
    const gl = this.gl;
    const resize = this.gridSize[0] !== w || this.gridSize[1] !== h;
    gl.bindTexture(gl.TEXTURE_2D, this.texChar);
    if (resize) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, indices);
    else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED, gl.UNSIGNED_BYTE, indices);
    gl.bindTexture(gl.TEXTURE_2D, this.texColor);
    if (resize) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, w, h, 0, gl.RGB, gl.UNSIGNED_BYTE, colors);
    else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGB, gl.UNSIGNED_BYTE, colors);
    if (resize) {
      this.gridSize = [w, h];
      this.set("u_grid_size", [w, h]);
    }
  }

  render() {
    const gl = this.gl;
    const { width, height } = this.canvas;
    gl.viewport(0, 0, width, height);
    gl.clearColor(0.04, 0.03, 0.04, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.prog);
    this.set("u_viewport_size", [width, height]);
    this.set("u_time", (performance.now() - this.start) / 1000);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texAtlas);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.texChar);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.texColor);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}

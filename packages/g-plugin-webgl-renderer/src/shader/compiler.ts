import { Device, ProgramDescriptorSimple, VendorInfo, ViewportOrigin } from '../platform';
import { assert } from '../platform/utils';
import { ShaderLibrary } from '../render/utils';

const ES100_REPLACEMENTS: [RegExp, string][] = [
  // In GLSL 1.00 ES these functions are provided by an extension
  [/\btexture(2D|2DProj|Cube)Lod\(/g, 'texture$1LodEXT('],

  // Overloads in GLSL 3.00 map to individual functions. Note that we cannot
  // differentiate 2D,2DProj,Cube without type analysis so we choose the most common variant.
  [/\btexture\(/g, 'texture2D('],
  [/\btextureLod\(/g, 'texture2DLodEXT('],
];

type DefineMap = Map<string, string>;
export type ShaderFeature = 'MRT';
export type ShaderFeatureMap = Partial<Record<ShaderFeature, boolean>>;

function defineStr(k: string, v: string): string {
  return `#define ${k} ${v}`;
}

export function preprocessShader_GLSL(
  vendorInfo: VendorInfo,
  type: 'vert' | 'frag',
  source: string,
  defines: DefineMap | null = null,
  features: ShaderFeatureMap | null = null,
): string {
  const isGLSL100 = vendorInfo.glslVersion === '#version 100';
  const supportMRT = vendorInfo.supportMRT && !!features.MRT;

  // Garbage WebGL2 shader compiler until I get something better down the line...
  const lines = source
    .split('\n')
    .map((n) => {
      // Remove comments.
      return n.replace(/[/][/].*$/, '');
    })
    .filter((n) => {
      // Filter whitespace.
      const isEmpty = !n || /^\s+$/.test(n);
      return !isEmpty;
    });

  let definesString: string = '';
  if (defines !== null)
    definesString = [...defines.entries()].map(([k, v]) => defineStr(k, v)).join('\n');

  const precision =
    lines.find((line) => line.startsWith('precision')) || 'precision mediump float;';
  let rest = lines.filter((line) => !line.startsWith('precision')).join('\n');
  let extraDefines = '';

  if (vendorInfo.viewportOrigin === ViewportOrigin.UpperLeft)
    extraDefines += `${defineStr(`VIEWPORT_ORIGIN_TL`, `1`)}\n`;

  let outLayout = '';
  if (vendorInfo.explicitBindingLocations) {
    let set = 0,
      binding = 0,
      location = 0;

    rest = rest.replace(/^(layout\((.*)\))?\s*uniform(.+{)$/gm, (substr, cap, layout, rest) => {
      const layout2 = layout ? `${layout}, ` : ``;
      return `layout(${layout2}set = ${set}, binding = ${binding++}) uniform ${rest}`;
    });

    // XXX(jstpierre): WebGPU now binds UBOs and textures in different sets as a porting hack, hrm...
    set++;
    binding = 0;

    assert(vendorInfo.separateSamplerTextures);
    rest = rest.replace(/uniform sampler2D (.*);/g, (substr, samplerName) => {
      // Can't have samplers in vertex for some reason.
      return type === 'frag'
        ? `
layout(set = ${set}, binding = ${binding++}) uniform texture2D T_${samplerName};
layout(set = ${set}, binding = ${binding++}) uniform sampler S_${samplerName};
`
        : '';
    });

    rest = rest.replace(
      type === 'frag' ? /^\b(varying|in)\b/gm : /^\b(varying|out)\b/gm,
      (substr, tok) => {
        return `layout(location = ${location++}) ${tok}`;
      },
    );

    outLayout = 'layout(location = 0) ';

    extraDefines += `${defineStr(`gl_VertexID`, `gl_VertexIndex`)}\n`;
  }

  if (vendorInfo.separateSamplerTextures) {
    rest = rest.replace(/\bPD_SAMPLER_2D\((.*?)\)/g, (substr, samplerName) => {
      return `texture2D T_P_${samplerName}, sampler S_P_${samplerName}`;
    });

    rest = rest.replace(/\bPU_SAMPLER_2D\((.*?)\)/g, (substr, samplerName) => {
      return `SAMPLER_2D(P_${samplerName})`;
    });

    rest = rest.replace(/\bPP_SAMPLER_2D\((.*?)\)/g, (substr, samplerName) => {
      return `T_${samplerName}, S_${samplerName}`;
    });

    rest = rest.replace(/\bSAMPLER_2D\((.*?)\)/g, (substr, samplerName) => {
      return `sampler2D(T_${samplerName}, S_${samplerName})`;
    });
  } else {
    rest = rest.replace(/\bPD_SAMPLER_2D\((.*?)\)/g, (substr, samplerName) => {
      return `sampler2D P_${samplerName}`;
    });

    rest = rest.replace(/\bPU_SAMPLER_2D\((.*?)\)/g, (substr, samplerName) => {
      return `SAMPLER_2D(P_${samplerName})`;
    });

    rest = rest.replace(/\bPP_SAMPLER_2D\((.*?)\)/g, (substr, samplerName) => {
      return samplerName;
    });

    rest = rest.replace(/\bSAMPLER_2D\((.*?)\)/g, (substr, samplerName) => {
      return samplerName;
    });
  }

  const hasFragColor = rest.includes('gl_FragColor');

  let concat = `
${vendorInfo.glslVersion}
${isGLSL100 && supportMRT ? '#extension GL_EXT_draw_buffers : require' : ''}
${precision}
#define ${type.toUpperCase()}
${
  !isGLSL100
    ? `
#define attribute in
#define varying ${type === 'vert' ? 'out' : 'in'}
`
    : ``
}
#define main${type === 'vert' ? 'VS' : 'PS'} main
${extraDefines}
${
  (hasFragColor &&
    `
${
  (type === 'frag' &&
    !isGLSL100 &&
    `#define gl_FragColor gbuf_color
layout(location = 0) out vec4 gbuf_color;
`) ||
  ''
}
${
  (type === 'frag' && !isGLSL100 && supportMRT && `layout(location = 1) out vec4 gbuf_picking;`) ||
  ''
}
`) ||
  ''
}
${definesString}
${rest}
`.trim();

  if (vendorInfo.explicitBindingLocations && type === 'frag') {
    concat = concat.replace(/^\b(out)\b/gm, (substr, tok) => {
      return `layout(location = 0) ${tok}`;
    });
  }

  // GLSL 100 -> 300
  if (isGLSL100) {
    // interface blocks supported in GLSL ES 3.00 and above only
    concat = concat.replace(/\s*uniform\s*.*\s*{((?:\s*.*\s*)*?)};/g, (substr, uniforms) => {
      return uniforms.trim().replace(/^.*$/gm, (uniform: string) => {
        return uniform ? `uniform ${uniform.trim()}` : '';
      });
    });

    // MRT
    if (supportMRT) {
      if (type === 'frag') {
        const gBuffers = [];
        concat = concat.replace(
          /^layout\(location\s*=\s*\d*\)\s*out\s*vec4\s*(.*);$/gm,
          (_, buffer) => {
            gBuffers.push(buffer);
            return '';
          },
        );

        // append at the end of fragment shader
        concat = concat.replace(/^void\s*main\(\)\s*{$/gm, () => {
          return `void main() {
  ${gBuffers.map((gBuffer) => `vec4 ${gBuffer};`).join('\n')}
`;
        });

        const lastIndexOfMain = concat.lastIndexOf('}');
        concat =
          concat.substring(0, lastIndexOfMain) +
          `gbuf_color = gl_FragColor;
${gBuffers
  .map(
    (gBuffer, i) => `gl_FragData[${i}] = ${gBuffer};
`,
  )
  .join('\n')}` +
          concat.substring(lastIndexOfMain);
      }
    }

    // remove layout(location = 0)
    concat = concat.replace(/^\s*layout\((.*)\)/gm, '');

    for (const [pattern, replacement] of ES100_REPLACEMENTS) {
      concat = concat.replace(pattern, replacement);
    }
  }

  return concat;
}

export interface ProgramDescriptorSimpleWithOrig extends ProgramDescriptorSimple {
  vert: string;
  frag: string;
}

export function preprocessProgram_GLSL(
  vendorInfo: VendorInfo,
  vert: string,
  frag: string,
  defines: DefineMap | null = null,
  features: ShaderFeatureMap | null = null,
): ProgramDescriptorSimpleWithOrig {
  const preprocessedVert = preprocessShader_GLSL(vendorInfo, 'vert', vert, defines, features);
  const preprocessedFrag = preprocessShader_GLSL(vendorInfo, 'frag', frag, defines, features);
  return { vert, frag, preprocessedVert, preprocessedFrag };
}

export interface ProgramObjBag {
  both?: string;
  vert: string;
  frag: string;
  defines?: DefineMap;
  features?: ShaderFeatureMap;
}

export function preprocessProgramObj_GLSL(
  device: Device,
  obj: ProgramObjBag,
): ProgramDescriptorSimpleWithOrig {
  const defines = obj.defines !== undefined ? obj.defines : null;
  const features = obj.features !== undefined ? obj.features : null;
  const vert = obj.both !== undefined ? obj.both + obj.vert : obj.vert;
  const frag = obj.both !== undefined ? obj.both + obj.frag : obj.frag;
  return preprocessProgram_GLSL(device.queryVendorInfo(), vert, frag, defines, features);
}
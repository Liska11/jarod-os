// Une présentation PowerPoint (.pptx) : des diapositives « titre + puces », sur une maquette 16:9 sobre. Pas d'image, pas de notes, pas de lien.
import { xmlText } from "./xml.js";
import { zip } from "./zip.js";

export interface Slide {
  title: string;
  bullets?: string[];
}

export const PPTX_MAX_SLIDES = 100;
export const PPTX_MAX_BULLETS = 20;
export const PPTX_TEXT_MAX = 400;

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const NS = `xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}"`;
const GROUP = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

const TITLE_BOX = { x: 609600, y: 365760, cx: 10972800, cy: 1143000 };
const BODY_BOX = { x: 609600, y: 1645920, cx: 10972800, cy: 4480560 };

const placeholder = (id: number, name: string, ph: string, box: { x: number; y: number; cx: number; cy: number }, anchor: string): string =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph ${ph}/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.cx}" cy="${box.cy}"/></a:xfrm></p:spPr><p:txBody><a:bodyPr anchor="${anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/><a:p><a:endParaRPr lang="fr-FR"/></a:p></p:txBody></p:sp>`;

const LAYOUT = `${XML_HEAD}<p:sldLayout ${NS} type="obj" preserve="1"><p:cSld name="Titre et contenu"><p:spTree>${GROUP}${placeholder(2, "Titre", 'type="title"', TITLE_BOX, "ctr")}${placeholder(3, "Contenu", 'idx="1"', BODY_BOX, "t")}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

const MASTER = `${XML_HEAD}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GROUP}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="3600" b="1"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr marL="342900" indent="-342900"><a:buChar char="&#8226;"/><a:defRPr sz="2400"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:defRPr></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`;

const FILL = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
const LINE = '<a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>';
const THEME = `${XML_HEAD}<a:theme xmlns:a="${A}" name="Jarod"><a:themeElements><a:clrScheme name="Jarod"><a:dk1><a:srgbClr val="1F1F1F"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="2B3A55"/></a:dk2><a:lt2><a:srgbClr val="EEF1F6"/></a:lt2><a:accent1><a:srgbClr val="2F7DFF"/></a:accent1><a:accent2><a:srgbClr val="1FA971"/></a:accent2><a:accent3><a:srgbClr val="E8A317"/></a:accent3><a:accent4><a:srgbClr val="D6453D"/></a:accent4><a:accent5><a:srgbClr val="7A5AF8"/></a:accent5><a:accent6><a:srgbClr val="5B6B82"/></a:accent6><a:hlink><a:srgbClr val="2F7DFF"/></a:hlink><a:folHlink><a:srgbClr val="7A5AF8"/></a:folHlink></a:clrScheme><a:fontScheme name="Jarod"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Jarod"><a:fillStyleLst>${FILL}${FILL}${FILL}</a:fillStyleLst><a:lnStyleLst>${LINE}${LINE}${LINE}</a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst>${FILL}${FILL}${FILL}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;

function slideXml(s: Slide): string {
  const bullets = s.bullets ?? [];
  const title = `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Titre"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="fr-FR" sz="3600" b="1"/><a:t>${xmlText(s.title)}</a:t></a:r></a:p></p:txBody></p:sp>`;
  const body = bullets.length
    ? `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Contenu"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr><a:normAutofit/></a:bodyPr><a:lstStyle/>${bullets
        .map((b) => `<a:p><a:pPr marL="342900" indent="-342900"><a:buFont typeface="Arial"/><a:buChar char="&#8226;"/></a:pPr><a:r><a:rPr lang="fr-FR" sz="2400"/><a:t>${xmlText(b)}</a:t></a:r></a:p>`)
        .join("")}</p:txBody></p:sp>`
    : "";
  return `${XML_HEAD}<p:sld ${NS}><p:cSld><p:spTree>${GROUP}${title}${body}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

export function buildPptx(opts: { title?: string; slides: Slide[] }): Buffer {
  const { slides } = opts;
  if (!slides.length) throw new Error("Au moins une diapositive est nécessaire.");
  if (slides.length > PPTX_MAX_SLIDES) throw new Error(`Trop de diapositives (${PPTX_MAX_SLIDES} au plus).`);
  const clean = slides.map((s, i) => {
    const title = String(s?.title ?? "").replace(/\s+/g, " ").trim();
    if (!title) throw new Error(`Diapositive ${i + 1} : « title » est vide.`);
    const bullets = (s.bullets ?? []).map((b) => String(b ?? "").replace(/\s+/g, " ").trim().slice(0, PPTX_TEXT_MAX)).filter(Boolean);
    if (bullets.length > PPTX_MAX_BULLETS) throw new Error(`Diapositive ${i + 1} : trop de puces (${PPTX_MAX_BULLETS} au plus).`);
    return { title: title.slice(0, PPTX_TEXT_MAX), bullets };
  });
  const n = clean.length;
  return zip([
    {
      name: "[Content_Types].xml",
      data: `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${clean.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("")}</Types>`,
    },
    {
      name: "_rels/.rels",
      data: `${XML_HEAD}<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
    },
    {
      name: "ppt/presentation.xml",
      data: `${XML_HEAD}<p:presentation ${NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${clean.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join("")}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
    },
    {
      name: "ppt/_rels/presentation.xml.rels",
      data: `${XML_HEAD}<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${R}/slideMaster" Target="slideMasters/slideMaster1.xml"/>${clean.map((_, i) => `<Relationship Id="rId${i + 2}" Type="${R}/slide" Target="slides/slide${i + 1}.xml"/>`).join("")}<Relationship Id="rId${n + 2}" Type="${R}/theme" Target="theme/theme1.xml"/></Relationships>`,
    },
    { name: "ppt/slideMasters/slideMaster1.xml", data: MASTER },
    {
      name: "ppt/slideMasters/_rels/slideMaster1.xml.rels",
      data: `${XML_HEAD}<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${R}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="${R}/theme" Target="../theme/theme1.xml"/></Relationships>`,
    },
    { name: "ppt/slideLayouts/slideLayout1.xml", data: LAYOUT },
    {
      name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
      data: `${XML_HEAD}<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${R}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`,
    },
    { name: "ppt/theme/theme1.xml", data: THEME },
    ...clean.flatMap((s, i) => [
      { name: `ppt/slides/slide${i + 1}.xml`, data: slideXml(s) },
      {
        name: `ppt/slides/_rels/slide${i + 1}.xml.rels`,
        data: `${XML_HEAD}<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${R}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`,
      },
    ]),
  ]);
}


// DDS (decoded to a canvas) and browser-native image previews, with PNG export.
import { el, button, downloadBlob, toast } from '../ui.js';
import { decodeDds } from '../formats/dds.js';
import { baseName } from '../util.js';

function zoomControls(target) {
  const sel = el(
    'select',
    { class: 'input input-sm', 'aria-label': 'Zoom' },
    ['fit', '0.5', '1', '2', '4'].map((z) => el('option', { value: z }, z === 'fit' ? 'Fit' : `${Number(z) * 100}%`)),
  );
  const apply = () => {
    const z = sel.value;
    target.classList.toggle('fit', z === 'fit');
    target.style.width = z === 'fit' ? '' : `${target.dataset.w * Number(z)}px`;
  };
  sel.addEventListener('change', apply);
  apply();
  return sel;
}

const bgToggle = (stage) =>
  button('Background', () => stage.classList.toggle('stage-dark'), { title: 'Switch between checkerboard and dark background' });

export function renderMedia(node, ctx, showHex) {
  const name = baseName(node.name).replace(/\.[^.]*$/, '');
  if (node.kind === 'dds') {
    let img;
    try {
      img = decodeDds(node.payload);
    } catch (e) {
      return el('div', { class: 'view' }, el('p', { class: 'note' }, `Preview not available: ${e.message}`), button('Show bytes', showHex));
    }
    const canvas = el('canvas', { class: 'pixels fit', width: img.width, height: img.height, 'aria-label': `${node.name} preview`, role: 'img' });
    canvas.dataset.w = img.width;
    canvas.getContext('2d').putImageData(new ImageData(img.rgba, img.width, img.height), 0, 0);
    const stage = el('div', { class: 'stage' }, canvas);
    const exportPng = () =>
      canvas.toBlob((b) => (b ? downloadBlob(b, `${name}.png`) : toast('PNG export failed', 'error')), 'image/png');
    return el(
      'div',
      { class: 'view media-view' },
      el(
        'div',
        { class: 'toolbar' },
        el('span', { class: 'chip' }, img.info.format),
        el('span', { class: 'muted' }, `${img.width} × ${img.height} · ${img.info.mips} mip${img.info.mips === 1 ? '' : 's'}`),
        el('span', { class: 'spacer' }),
        zoomControls(canvas),
        bgToggle(stage),
        button('Export PNG', exportPng),
      ),
      stage,
    );
  }
  const url = URL.createObjectURL(new Blob([node.payload], { type: node.mime }));
  const im = el('img', { class: 'pixels fit', src: url, alt: `${node.name} preview` });
  const size = el('span', { class: 'muted' });
  const zoom = zoomControls(im);
  im.addEventListener('load', () => {
    im.dataset.w = im.naturalWidth;
    size.textContent = `${im.naturalWidth} × ${im.naturalHeight}`;
    zoom.dispatchEvent(new Event('change'));
  });
  const stage = el('div', { class: 'stage' }, im);
  return el(
    'div',
    { class: 'view media-view' },
    el('div', { class: 'toolbar' }, el('span', { class: 'chip' }, node.mime.replace('image/', '').toUpperCase()), size, el('span', { class: 'spacer' }), zoom, bgToggle(stage)),
    stage,
  );
}

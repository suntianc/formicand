/**
 * The Formicand ant as a working indicator: head, thorax and abdomen swell in
 * turn, as if it were walking. Drawn from the logo's own geometry in the text
 * color; styles live in styles/conversation.css (`.ant-mark`).
 *
 * The still feelers are SVG; the three body parts that move are plain boxes
 * placed over them. A transform on an SVG shape cannot run on the compositor,
 * so it relaid the whole page every frame; on a box it never reaches the page.
 */
const FEELERS =
  '<g transform="translate(2.545 2.545)">' +
  '<circle class="ant-feeler" cx="76.7366" cy="26.9299" r="5.155"/>' +
  '<circle class="ant-feeler" cx="26.9299" cy="76.7366" r="5.155"/>' +
  '<path class="ant-feeler" transform="translate(48.4495 28.7755)" d="M-.389 3.049l20.337-4.723 .777 3.348-20.336 4.722z"/>' +
  '<path class="ant-feeler" transform="translate(65.4404 33.3486)" d="M7.607 1.061l-6.256 7.967-2.702-2.123 6.255-7.966z"/>' +
  '<path class="ant-feeler" transform="translate(33.3486 65.4404)" d="M9.028 1.351l-7.967 6.256-2.122-2.703 7.966-6.255z"/>' +
  '<path class="ant-feeler" transform="translate(35.0664 77.3704)" d="M.133-1.713l22.754 1.773-.267 3.426-22.753-1.773z"/>' +
  "</g>";

/** The mark: its SVG feelers and the three moving parts; the caller's element sizes it. */
export const antMarkSvg =
  `<svg class="ant-mark-svg" viewBox="16 16 96 96" aria-hidden="true" focusable="false">${FEELERS}</svg>` +
  '<span class="ant-body ant-head"></span><span class="ant-body ant-thorax"></span><span class="ant-body ant-abdomen"></span>';

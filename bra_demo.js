/* =====================================================================
 * bra_demo.js — the model, the timeline, and the drawing for the BRA
 * companion page.
 *
 * WHAT THE PAGE SHOWS
 * A researcher reports a statistically significant but tiny difference
 * and asks whether it supports a mechanistic claim. The agent extracts
 * the individual propositions in that claim, asks for the magnitude,
 * retrieves the magnitude this literature treats as regulation, and
 * scores each proposition with two quantities:
 *
 *   S, decision stability   P(true effect > threshold | data). A property
 *                           of the result actually obtained. It answers
 *                           "is the effect large enough to act on?"
 *
 *   C, epistemic capacity   |ln[(1 - beta) / alpha]|, in nats. A property
 *                           of the design, fixed before any data exist.
 *                           It is a budget: the largest revision of belief
 *                           one decision from this design can justify.
 *
 * HOW IT IS ORGANIZED
 * The page is a pure function of one number: elapsed story time in
 * milliseconds. `render(t)` sets every visible element from `t` and
 * nothing else holds animation state, so playing, pausing, restarting,
 * dragging the scrubber, and stepping with the arrow keys all reduce to
 * choosing a value of `t`. That is why dragging is exact rather than
 * approximate: the scrubber maps 1:1 onto the timeline.
 *
 * Sections, in order:
 *   1. The statistical model
 *   2. The scenario: copy, propositions, timeline
 *   3. Element references
 *   4. Building the conversation and the ledger
 *   5. Drawing the posterior
 *   6. Drawing the capacity meter
 *   7. render(t): the single source of truth
 *   8. Playback: clock, buttons, scrubbing, keyboard
 *   9. The explorers
 *  10. Start
 * ===================================================================== */
"use strict";


/* ---------------------------------------------------------------------
 * 1. The statistical model
 * ------------------------------------------------------------------ */

/* Spread of the posterior over the TRUE change, in percentage points.
 *
 * This is deliberately not the standard error the researcher's p-value
 * is based on. With 10,000 cells per condition that nominal precision is
 * about 0.15 pp, but cells within one condition are pseudoreplicates:
 * counting more of them says almost nothing about how well the
 * experiment pins down the effect of knocking out X. The spread that
 * matters is the variation between biological replicates, an order of
 * magnitude wider. Using the nominal standard error here would turn S
 * into a step function at the threshold, which is exactly the false
 * certainty the poster argues against. */
const REPLICATE_SD = 1.55;

/* The change in Y this literature treats as evidence of regulation, in
 * percentage points. This is the threshold tau in S = P(true > tau). */
const THRESHOLD = 15.0;

/* The design the researcher actually ran. These are the starting points
 * for the sliders under the capacity meter, and the values the page
 * returns to whenever the walk-through is replayed. */
const ALPHA = 0.05;
const POWER = 0.99;

/* Epistemic capacity, in nats: the largest revision of belief that one
 * decision taken at this operating point can justify. A property of the
 * design alone, computable before a single measurement exists. */
function capacity(alpha, power) {
  return Math.abs(Math.log(power / alpha));
}

/* What the claim demands: asserting a previously unknown mechanism means
 * overturning prior odds of roughly 1000:1 against, so it costs ln(1000)
 * nats. Supply has to reach this demand before the claim is arguable. */
const CAPACITY_REQUIRED = Math.log(1000);

/* The value of S at which the poster treats a result as firm enough to
 * act on. Capacity and stability are separate tests and a claim has to
 * pass both: enough budget to justify the revision, and a result solid
 * enough to spend it on. */
const STABILITY_TO_ACT = 0.80;

/* The magnitude the researcher eventually reports, in percentage points. */
const OBSERVED_CHANGE = 1.0;

/* Live state, driven by the three sliders once the walk-through ends.
 * During the scripted portion `render` holds them at the values above,
 * so a replay always tells the same story. */
let currentAlpha = ALPHA;
let currentPower = POWER;
let currentObserved = OBSERVED_CHANGE;

/* Error function, Abramowitz & Stegun 7.1.26. Accurate to about 1.5e-7,
 * which is far finer than the two decimals the page ever displays.
 * JavaScript has no erf of its own, hence the explicit series. */
function erf(x) {
  const sign = Math.sign(x);
  x = Math.abs(x);

  const a1 =  0.254829592;
  const a2 = -0.284496736;
  const a3 =  1.421413741;
  const a4 = -1.453152027;
  const a5 =  1.061405429;
  const p  =  0.3275911;

  const t = 1 / (1 + p * x);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

/* Standard normal cumulative distribution function. */
function normalCdf(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/* Decision stability: the posterior probability that the true change
 * exceeds `threshold`, given an observed change and the replicate-level
 * spread. Under a flat prior and a normal likelihood this is simply the
 * upper tail of a normal centered on what was measured. */
function stabilityScore(observed, threshold, spread) {
  return 1 - normalCdf((threshold - observed) / spread);
}


/* ---------------------------------------------------------------------
 * 2. The scenario
 * ------------------------------------------------------------------ */

/* The researcher's opening question. HTML rather than plain text so the
 * exponent in the p-value can be set properly. */
const QUESTION_HTML =
    "I knocked out transcription factor X and measured protein Y in "
  + "10,000 cells per condition. Y was lower in the knockouts "
  + "(p &lt; 10<sup>&minus;10</sup>). Can I claim that X regulates Y?";

/* The claim decomposed into single propositions.
 *   text       what the proposition asserts
 *   provenance where it would have to be settled
 *   score      S, where it is known in advance; null where the agent has
 *              to compute it during the walk-through */
const PROPOSITIONS = [
  {
    id: "p1",
    text: "Y is lower in X-knockout cells than in controls.",
    provenance: "measurement, directly observed",
    score: 1.00
  },
  {
    id: "p2",
    text: "The change in Y is large enough to count as regulation.",
    provenance: "needs a magnitude and a threshold",
    score: null
  },
  {
    id: "p3",
    text: "X regulates Y.",
    provenance: "mechanistic conclusion, inherits the weakest link",
    score: null
  }
];

/* Named moments in story time, in milliseconds. Every reveal in
 * `render` keys off one of these, so retiming the walk-through means
 * editing this object and nothing else. */
const TIME = {
  question:           200,   // the researcher's turn appears
  claimsExtracted:   2600,   // first proposition enters the ledger
  secondClaim:       3200,
  thirdClaim:        3800,
  agentAsks:         5200,   // "by how much did Y change?"
  magnitudeGiven:    7600,   // "it fell by 1%"
  thresholdKnown:    9600,   // tau drawn on the plot
  stabilityComputed:12200,   // S drawn and written into the ledger
  capacityChecked:  15000,   // the meter fills
  answer:           17600,   // the agent's closing turn
  verdict:          19400,   // the summary panel
  explore:          21000,   // the slider unfolds
  end:              21600    // playback stops here
};

/* Scrubber ticks, in order. `at` places the tick; `label` names the step
 * in the readout to the right of the scrubber. */
const STEPS = [
  { at: 0,                       label: "the question" },
  { at: TIME.claimsExtracted,    label: "claims extracted" },
  { at: TIME.agentAsks,          label: "BRA asks" },
  { at: TIME.magnitudeGiven,     label: "magnitude given" },
  { at: TIME.thresholdKnown,     label: "threshold retrieved" },
  { at: TIME.stabilityComputed,  label: "S computed" },
  { at: TIME.capacityChecked,    label: "C checked" },
  { at: TIME.answer,             label: "the answer" },
  { at: TIME.explore,            label: "explore" }
];


/* ---------------------------------------------------------------------
 * 3. Element references
 *
 * Looked up once. Every id here exists in bra_demo.html; renaming one
 * means renaming it in both files.
 * ------------------------------------------------------------------ */
const chatColumn        = document.getElementById("chatColumn");
const ledgerBody        = document.getElementById("ledgerBody");
const verdictBox        = document.getElementById("verdictBox");
const thinkingIndicator = document.getElementById("thinkingIndicator");
const thinkingLabel     = document.getElementById("thinkingLabel");

const posteriorPlot     = document.getElementById("posteriorPlot");

const capacityFill      = document.getElementById("capacityFill");
const capacityNeed      = document.getElementById("capacityNeed");
const capacityLabel     = document.getElementById("capacityLabel");
const capacityChips     = document.getElementById("capacityChips");

const playButton        = document.getElementById("playButton");
const playIcon          = document.getElementById("playIcon");
const playLabel         = document.getElementById("playLabel");
const restartButton     = document.getElementById("restartButton");
const scrubber          = document.getElementById("scrubber");
const scrubberProgress  = document.getElementById("scrubberProgress");
const stepReadout       = document.getElementById("stepReadout");

const capacityControls  = document.getElementById("capacityControls");
const alphaSlider       = document.getElementById("alphaSlider");
const alphaReadout      = document.getElementById("alphaReadout");
const powerSlider       = document.getElementById("powerSlider");
const powerReadout      = document.getElementById("powerReadout");

const exploreCard       = document.getElementById("exploreCard");
const effectSlider      = document.getElementById("effectSlider");
const sliderReadout     = document.getElementById("sliderReadout");


/* ---------------------------------------------------------------------
 * 4. Building the conversation and the ledger
 * ------------------------------------------------------------------ */

/* Append one chat turn and hand back the element, so `render` can
 * reveal it later by toggling the "on" class.
 *
 * `side` is "from-researcher" or "from-agent", optionally with
 * "is-question" to draw the bubble dashed and unfilled. */
function addTurn(side, speaker, bodyHtml) {
  const turn = document.createElement("div");
  turn.className = "turn " + side;
  turn.innerHTML =
      `<p class="speaker">${speaker}</p>`
    + `<div class="bubble">${bodyHtml}</div>`;
  chatColumn.appendChild(turn);
  return turn;
}

const turnQuestion = addTurn("from-researcher", "Researcher", QUESTION_HTML);

const turnAgentAsks = addTurn("from-agent is-question", "BRA",
  "&ldquo;By how much did Y change?&rdquo;");

const turnMagnitude = addTurn("from-researcher", "Researcher",
  "It fell by 1%.");

const turnAnswer = addTurn("from-agent", "BRA",
    "&ldquo;In published knockdown studies of X, changes in Y of 15&ndash;20% are "
  + "treated as evidence of regulation. A 1% change falls well below that, and "
  + "with 10,000 cells even a negligible difference reaches significance. "
  + "<b>A change this small does not seem to support the mechanistic claim that "
  + "X regulates Y.</b>&rdquo;");

/* Build one ledger row per proposition and keep direct references to the
 * two elements that change (the printed S and the filled bar), so
 * updating a score never has to search the document again. */
const ledgerRows = {};

PROPOSITIONS.forEach(proposition => {
  const row = document.createElement("div");
  row.className = "proposition";
  row.innerHTML =
      `<div class="proposition-text">${proposition.text}`
    + `<em>${proposition.provenance}</em></div>`
    + `<div class="proposition-score">&mdash;</div>`
    + `<div class="score-bar"><i></i></div>`;
  ledgerBody.appendChild(row);

  ledgerRows[proposition.id] = {
    row:      row,
    scoreEl:  row.querySelector(".proposition-score"),
    barFill:  row.querySelector(".score-bar i")
  };
});

/* Dim or undim a proposition, i.e. show whether the agent has extracted
 * it yet. */
function setPropositionVisible(id, visible) {
  ledgerRows[id].row.classList.toggle("on", visible);
}

/* Write S into one ledger row, or clear it back to an em dash when the
 * agent has not computed it yet. The bar is filled to S x 100%. */
function setPropositionScore(id, value, color) {
  const { scoreEl, barFill } = ledgerRows[id];

  if (value === null) {
    scoreEl.innerHTML = "&mdash;";
    scoreEl.style.color = "var(--mute)";
    barFill.style.width = "0";
    return;
  }

  scoreEl.textContent = value.toFixed(2);
  scoreEl.style.color = color;
  barFill.style.width = (value * 100) + "%";
  barFill.style.background = color;
}


/* ---------------------------------------------------------------------
 * 5. Drawing the posterior
 *
 * The plot is rebuilt from scratch on every frame. At this size that is
 * cheaper than tracking which elements need updating, and it keeps the
 * drawing code a plain function of its arguments.
 * ------------------------------------------------------------------ */

const SVG_NS = "http://www.w3.org/2000/svg";

/* Plot geometry, in the units of the viewBox declared in the HTML. */
const PLOT_W = 460;
const PLOT_H = 168;
const PAD_LEFT = 8;
const PAD_RIGHT = 8;
const PAD_TOP = 14;
const PAD_BOTTOM = 26;

/* The x axis runs from 0 to 26% change: far enough to leave headroom
 * above the 25% end of the explorer's slider. */
const X_MAX = 26;

/* Percentage change to horizontal position inside the viewBox. */
function xPixel(percentChange) {
  return PAD_LEFT + (percentChange / X_MAX) * (PLOT_W - PAD_LEFT - PAD_RIGHT);
}

/* Create an SVG element with the given attributes. */
function svgEl(name, attributes) {
  const element = document.createElementNS(SVG_NS, name);
  for (const key in attributes) {
    element.setAttribute(key, attributes[key]);
  }
  return element;
}

/* SVG text has no background of its own, so an annotation sitting over
 * the curve or the shaded tail becomes hard to read. Measure the block
 * once it is already in the document, then slip a translucent white
 * plate in behind it. Called after appending, never before, because
 * getBBox only reports a real box for a rendered element. */
function addBackingPlate(textNodes, pad) {
  const padding = (pad === undefined) ? 4 : pad;

  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  textNodes.forEach(node => {
    const box = node.getBBox();
    left   = Math.min(left,   box.x);
    top    = Math.min(top,    box.y);
    right  = Math.max(right,  box.x + box.width);
    bottom = Math.max(bottom, box.y + box.height);
  });

  // Nothing measurable, e.g. the plot is not being displayed.
  if (!isFinite(left)) return;

  const plate = svgEl("rect", {
    x: left - padding,
    y: top - padding * 0.7,
    width:  (right - left) + 2 * padding,
    height: (bottom - top) + 1.4 * padding,
    rx: 4,
    fill: "#ffffff",
    "fill-opacity": 0.82
  });
  posteriorPlot.insertBefore(plate, textNodes[0]);
}

/* Draw the posterior over the true change.
 *
 *   observed   the measured change, in percentage points
 *   threshold  tau, the magnitude that would count as regulation
 *   reveal     how much of the machinery to show:
 *                0  the curve and the measurement only
 *                1  plus the threshold line and the shaded tail
 *                2  plus the printed value of S
 *              The staging matters: the agent cannot show a threshold it
 *              has not retrieved, or a score it has not computed. */
function drawPosterior(observed, threshold, reveal) {
  posteriorPlot.innerHTML = "";

  const plotHeight = PLOT_H - PAD_TOP - PAD_BOTTOM;
  const baseline = PAD_TOP + plotHeight;

  // --- axis ---
  posteriorPlot.appendChild(svgEl("line", {
    x1: PAD_LEFT, y1: baseline, x2: PLOT_W - PAD_RIGHT, y2: baseline,
    stroke: "#DFE4E8", "stroke-width": 1
  }));

  [0, 5, 10, 15, 20, 25].forEach(tick => {
    const label = svgEl("text", {
      x: xPixel(tick), y: baseline + 15,
      "text-anchor": "middle", class: "axis-label"
    });
    label.textContent = tick + "%";
    posteriorPlot.appendChild(label);
  });

  /* The curve, drawn to scale. The density is divided by its own peak so
   * the mode always reaches the same height whatever the spread; 0.86
   * leaves headroom for the annotations at the top. */
  const peakDensity = 1 / (REPLICATE_SD * Math.sqrt(2 * Math.PI));

  function yPixel(percentChange) {
    const density =
      Math.exp(-0.5 * ((percentChange - observed) / REPLICATE_SD) ** 2)
      / (REPLICATE_SD * Math.sqrt(2 * Math.PI));
    return baseline - (density / peakDensity) * plotHeight * 0.86;
  }

  const CURVE_SEGMENTS = 460;
  let curvePath = "";
  for (let i = 0; i <= CURVE_SEGMENTS; i++) {
    const value = X_MAX * i / CURVE_SEGMENTS;
    curvePath += (i ? "L" : "M")
               + xPixel(value).toFixed(1) + " " + yPixel(value).toFixed(1);
  }

  // Pale fill under the whole curve.
  posteriorPlot.appendChild(svgEl("path", {
    d: curvePath + `L${xPixel(X_MAX)} ${baseline}L${xPixel(0)} ${baseline}Z`,
    fill: "#2E5F86", "fill-opacity": 0.14, stroke: "none"
  }));

  /* The mass above the threshold IS S, so it is drawn rather than merely
   * asserted: the shaded area and the printed number are the same
   * quantity, and a reader can check one against the other. */
  if (reveal >= 1) {
    const TAIL_SEGMENTS = 260;
    let tailPath = "";
    for (let i = 0; i <= TAIL_SEGMENTS; i++) {
      const value = threshold + (X_MAX - threshold) * i / TAIL_SEGMENTS;
      tailPath += (i ? "L" : "M")
                + xPixel(value).toFixed(1) + " " + yPixel(value).toFixed(1);
    }
    posteriorPlot.appendChild(svgEl("path", {
      d: tailPath + `L${xPixel(X_MAX)} ${baseline}L${xPixel(threshold)} ${baseline}Z`,
      fill: "#009E73", "fill-opacity": 0.34, stroke: "none"
    }));
  }

  // The curve outline, drawn last so it sits above both fills.
  posteriorPlot.appendChild(svgEl("path", {
    d: curvePath, fill: "none", stroke: "#2E5F86", "stroke-width": 2
  }));

  // --- threshold ---
  if (reveal >= 1) {
    posteriorPlot.appendChild(svgEl("line", {
      x1: xPixel(threshold), y1: PAD_TOP - 2,
      x2: xPixel(threshold), y2: baseline,
      stroke: "#1A1A1A", "stroke-width": 1.6, "stroke-dasharray": "5 4"
    }));

    const thresholdLabel = svgEl("text", {
      x: xPixel(threshold) + 7, y: PAD_TOP + 11, class: "annotation"
    });
    thresholdLabel.textContent = "τ = " + threshold + "%";
    posteriorPlot.appendChild(thresholdLabel);
    addBackingPlate([thresholdLabel], 3);
  }

  /* --- the measurement ---
   * Past the midpoint the label block is flipped to the left of the
   * marker, so a large observed value does not push the text off the
   * panel. This matters once the explorer's slider is in play. */
  const flipLeft = xPixel(observed) > PLOT_W * 0.52;
  const labelX = flipLeft ? xPixel(observed) - 9 : xPixel(observed) + 9;
  const anchor = flipLeft ? "end" : "start";
  const labelY = PAD_TOP + plotHeight * 0.40;

  const measuredLine = svgEl("text", {
    x: labelX, y: labelY, "text-anchor": anchor, class: "annotation"
  });
  measuredLine.textContent = "measured " + observed.toFixed(1) + "%";
  posteriorPlot.appendChild(measuredLine);

  const spreadLine = svgEl("text", {
    x: labelX, y: labelY + 14, "text-anchor": anchor, class: "axis-label"
  });
  spreadLine.textContent =
    "±" + REPLICATE_SD.toFixed(1) + " pp between replicates";
  posteriorPlot.appendChild(spreadLine);

  // Names the pseudoreplication point the whole demo turns on.
  // const caveatLine = svgEl("text", {
  //  x: labelX, y: labelY + 27, "text-anchor": anchor, class: "axis-label"
  // });
  // caveatLine.textContent =
  //  "(the p-value's ±0.15 pp counts cells, not replicates)";
  // posteriorPlot.appendChild(caveatLine);

  addBackingPlate([measuredLine, spreadLine], 5);

  posteriorPlot.appendChild(svgEl("circle", {
    cx: xPixel(observed), cy: yPixel(observed), r: 3.6, fill: "#2E5F86"
  }));

  // --- the S readout ---
  if (reveal >= 2) {
    const s = stabilityScore(observed, threshold, REPLICATE_SD);

    const scoreText = svgEl("text", {
      x: PLOT_W - PAD_RIGHT, y: PAD_TOP + 16, "text-anchor": "end",
      class: "annotation", "font-weight": "700", "font-size": "14"
    });
    scoreText.textContent = "S = " + s.toFixed(2);
    // Green once S clears the 0.80 band used throughout the poster.
    scoreText.setAttribute("fill", s >= 0.8 ? "#009E73" : "#D55E00");
    posteriorPlot.appendChild(scoreText);

    const bandText = svgEl("text", {
      x: PLOT_W - PAD_RIGHT, y: PAD_TOP + 32, "text-anchor": "end",
      class: "axis-label"
    });
    if (s >= 0.95)      bandText.textContent = "very high";
    else if (s >= 0.80) bandText.textContent = "high";
    else if (s >= 0.50) bandText.textContent = "moderate";
    else if (s >= 0.05) bandText.textContent = "low";
    else                bandText.textContent = "mass above τ is negligible";
    posteriorPlot.appendChild(bandText);

    addBackingPlate([scoreText, bandText], 4);
  }
}


/* ---------------------------------------------------------------------
 * 6. Drawing the capacity meter
 * ------------------------------------------------------------------ */

/* The meter spans 0 to 10 nats. Both the fill and the marker are placed
 * as a fraction of that span, clamped so a value above 10 pins to the
 * right end rather than overflowing the track. The alpha slider's range
 * is set in the HTML so that the largest reachable C stays under 10 and
 * the clamp never actually engages. */
const METER_MAX_NATS = 10;

// The demand marker never moves, so it is positioned once at load.
capacityNeed.style.left =
  Math.min(CAPACITY_REQUIRED / METER_MAX_NATS, 1) * 100 + "%";
capacityNeed.style.opacity = 0;

/* The joint test, and the whole argument of the page in one function.
 *
 * Capacity and stability answer different questions and neither answer
 * substitutes for the other:
 *
 *   supply < demand      No result whatsoever from this design can carry
 *                        the claim. The reader can fix this by tightening
 *                        alpha, which is a decision about the design, not
 *                        about the data.
 *
 *   supply >= demand,    The design could carry the claim, but the effect
 *   S < threshold        that was actually measured is not firm enough to
 *                        spend that budget on.
 *
 *   both met             This study on its own can support the claim.
 *
 * Returns the chip text and color for the case in hand. */
function jointVerdict(supplied, stability) {
  if (supplied < CAPACITY_REQUIRED) {
    return { text: "one experiment is not enough", color: "#D55E00" };
  }
  if (stability < STABILITY_TO_ACT) {
    return { text: "capacity is enough, this result is not", color: "#E69F00" };
  }
  return { text: "this study alone could support the claim", color: "#009E73" };
}

/* Show or hide the capacity comparison, computed from whatever operating
 * point the sliders are currently at. Called with `visible` false for
 * every frame before the agent gets to this step, which is what lets the
 * scrubber run backwards as cleanly as it runs forwards. */
function drawCapacity(visible) {
  const supplied = capacity(currentAlpha, currentPower);

  capacityFill.style.width = visible
    ? Math.min(supplied / METER_MAX_NATS, 1) * 100 + "%"
    : "0%";

  /* Two decimals, not one. The interesting part of the alpha slider's
   * range is the neighborhood of the requirement, and at one decimal a
   * design supplying 6.898 nats and a claim costing 6.908 both print as
   * 6.9, so the verdict would appear to contradict the numbers beside
   * it. The alternative, flipping the verdict wherever the rounded
   * values meet, would quietly loosen the C >= K rule the page is
   * arguing for. */
  capacityLabel.innerHTML = visible
    ? "C = " + supplied.toFixed(2) + " nats"
    : "C = &mdash;";

  capacityNeed.style.opacity = visible ? 1 : 0;

  if (!visible) {
    capacityChips.innerHTML = "";
    return;
  }

  /* The verdict reads the effect currently on the plot, so moving either
   * the design sliders or the effect slider updates it. Note that
   * changing alpha or power does NOT move S: the stability of a result
   * already in hand cannot be improved by redescribing the design. */
  const stability = stabilityScore(currentObserved, THRESHOLD, REPLICATE_SD);
  const verdict = jointVerdict(supplied, stability);

  capacityChips.innerHTML =
      `<span class="chip">design gives <b>${supplied.toFixed(2)}</b> nats</span>
       <span class="chip">a new mechanism needs <b>${CAPACITY_REQUIRED.toFixed(2)}</b> nats</span>
       <span class="chip" style="border-color:${verdict.color};color:${verdict.color}">${verdict.text}</span>`;
}

/* Put the three sliders and the values they drive back to the design the
 * researcher actually ran. Called on every scripted frame, so replaying
 * or scrubbing backwards always restores the original story. */
function resetControls() {
  currentAlpha = ALPHA;
  currentPower = POWER;
  currentObserved = OBSERVED_CHANGE;

  alphaSlider.value = Math.log10(ALPHA);
  powerSlider.value = POWER;
  effectSlider.value = OBSERVED_CHANGE;

  alphaReadout.textContent = formatAlpha(ALPHA);
  powerReadout.textContent = Math.round(POWER * 100) + "%";
  sliderReadout.innerHTML =
    "Y fell by " + OBSERVED_CHANGE.toFixed(1) + "% &nbsp;&rarr;&nbsp; S = "
    + stabilityScore(OBSERVED_CHANGE, THRESHOLD, REPLICATE_SD).toFixed(2);
  sliderReadout.style.color = "";
}

/* Alpha spans four orders of magnitude, so one fixed number of decimals
 * cannot serve the whole range: it would print 0.05 as 0.0500 and 0.0001
 * as 0.000. Use as many decimals as the value needs, and scientific
 * notation once there are too many to read. */
const SUPERSCRIPT_DIGITS = ["⁰", "¹", "²", "³", "⁴", "⁵", "⁶", "⁷", "⁸", "⁹"];

function formatAlpha(alpha) {
  if (alpha >= 0.01)  return alpha.toFixed(3).replace(/0+$/, "");
  if (alpha >= 0.001) return alpha.toFixed(4).replace(/0+$/, "");

  const [mantissa, exponent] = alpha.toExponential(1).split("e");
  const digits = String(Math.abs(Number(exponent)))
    .split("")
    .map(d => SUPERSCRIPT_DIGITS[Number(d)])
    .join("");
  return mantissa + " × 10⁻" + digits;
}


/* ---------------------------------------------------------------------
 * 7. render(t): the single source of truth
 *
 * Sets the entire page from elapsed story time. Every branch is a plain
 * comparison against TIME, never an accumulation, so calling render with
 * any `t` in any order gives the same result.
 * ------------------------------------------------------------------ */
function render(t) {

  /* Everything before the explorer opens is scripted, so the sliders are
   * held at the design the researcher actually ran. Without this,
   * replaying after a reader had moved them would narrate the original
   * conversation over somebody else's numbers. */
  if (t < TIME.explore) resetControls();

  // --- conversation ---
  turnQuestion.classList.toggle("on",  t >= TIME.question);
  turnAgentAsks.classList.toggle("on", t >= TIME.agentAsks);
  turnMagnitude.classList.toggle("on", t >= TIME.magnitudeGiven);
  turnAnswer.classList.toggle("on",    t >= TIME.answer);

  /* The agent is visibly working in two stretches: while it decomposes
   * the question, and while it retrieves, scores and checks capacity. */
  const isThinking =
       (t >= TIME.claimsExtracted && t < TIME.agentAsks)
    || (t >= TIME.thresholdKnown  && t < TIME.answer);
  thinkingIndicator.classList.toggle("on", isThinking);

  if (t < TIME.agentAsks) {
    thinkingLabel.textContent = "extracting the claims";
  } else if (t < TIME.stabilityComputed) {
    thinkingLabel.textContent = "retrieving what counts as regulation for X and Y";
  } else if (t < TIME.capacityChecked) {
    thinkingLabel.textContent = "computing decision stability";
  } else {
    thinkingLabel.textContent = "checking what the design can carry";
  }

  // --- claim ledger ---
  setPropositionVisible("p1", t >= TIME.claimsExtracted);
  setPropositionVisible("p2", t >= TIME.secondClaim);
  setPropositionVisible("p3", t >= TIME.thirdClaim);

  // p1 is a direct observation, so its S is available immediately.
  setPropositionScore("p1", t >= TIME.claimsExtracted ? 1.00 : null, "#009E73");

  /* p2 and p3 share the same score: the mechanistic conclusion can be no
   * stronger than the magnitude claim it rests on, which is the weakest
   * link in the chain. */
  const s = stabilityScore(OBSERVED_CHANGE, THRESHOLD, REPLICATE_SD);
  setPropositionScore("p2", t >= TIME.stabilityComputed ? s : null, "#D55E00");
  setPropositionScore("p3", t >= TIME.stabilityComputed ? s : null, "#D55E00");

  // --- the two figures ---
  let reveal = 0;
  if (t >= TIME.stabilityComputed)   reveal = 2;
  else if (t >= TIME.thresholdKnown) reveal = 1;

  /* The plot is blank of threshold and score until the researcher has
   * supplied the magnitude, even if the clock has passed those moments. */
  drawPosterior(OBSERVED_CHANGE, THRESHOLD,
                t >= TIME.magnitudeGiven ? reveal : 0);
  drawCapacity(t >= TIME.capacityChecked);

  // --- closing panels ---
  verdictBox.classList.toggle("on", t >= TIME.verdict);
  exploreCard.classList.toggle("on", t >= TIME.explore);
  capacityControls.classList.toggle("on", t >= TIME.explore);

  // --- transport ---
  scrubberProgress.style.width = (Math.min(t / TIME.end, 1) * 100) + "%";

  // The current step is the last one whose start time has passed.
  let currentStep = 0;
  STEPS.forEach((step, i) => {
    if (t >= step.at) currentStep = i;
  });
  stepReadout.textContent =
    "step " + (currentStep + 1) + " of " + STEPS.length
    + " · " + STEPS[currentStep].label;

  document.querySelectorAll(".scrub .stop").forEach((tick, i) => {
    tick.classList.toggle("past", t >= STEPS[i].at);
  });
}


/* ---------------------------------------------------------------------
 * 8. Playback
 * ------------------------------------------------------------------ */

// One tick per step, placed as a percentage of total story time.
STEPS.forEach(step => {
  const tick = document.createElement("div");
  tick.className = "stop";
  tick.style.left = (step.at / TIME.end * 100) + "%";
  scrubber.appendChild(tick);
});

let elapsed = 0;          // current position in story time, ms
let isPlaying = false;
let lastTimestamp = null; // wall-clock time of the previous frame

/* Advance the clock by the real time since the previous frame, so the
 * walk-through runs at the same speed whatever the display refresh rate. */
function frame(timestamp) {
  if (!isPlaying) return;
  if (lastTimestamp === null) lastTimestamp = timestamp;

  elapsed = Math.min(elapsed + (timestamp - lastTimestamp), TIME.end);
  lastTimestamp = timestamp;
  render(elapsed);

  if (elapsed >= TIME.end) {
    isPlaying = false;
    updatePlayButton();
    return;
  }
  requestAnimationFrame(frame);
}

/* Keep the button's label and glyph in step with the clock: Play before
 * the start, Pause while running, Replay once the timeline has ended. */
function updatePlayButton() {
  if (isPlaying) {
    playLabel.textContent = "Pause";
  } else if (elapsed >= TIME.end) {
    playLabel.textContent = "Replay";
  } else {
    playLabel.textContent = "Play";
  }

  playIcon.innerHTML = isPlaying
    ? '<rect x="1" y="1" width="4" height="12" fill="currentColor"/>'
      + '<rect x="8" y="1" width="4" height="12" fill="currentColor"/>'
    : '<path d="M1 1l11 6-11 6z" fill="currentColor"/>';
}

function play() {
  // Pressing play at the end restarts rather than doing nothing.
  if (elapsed >= TIME.end) elapsed = 0;
  isPlaying = true;
  lastTimestamp = null;
  updatePlayButton();
  requestAnimationFrame(frame);
}

function pause() {
  isPlaying = false;
  lastTimestamp = null;   // discard the gap, so resuming does not jump
  updatePlayButton();
}

playButton.onclick = () => isPlaying ? pause() : play();
restartButton.onclick = () => { elapsed = 0; render(0); pause(); };

/* --- scrubbing --- */
/* Map a pointer position on the scrubber onto story time. Because
 * `render` depends on nothing but `t`, this is a genuine seek: the page
 * shows exactly what it would show had it played to that instant. */
function seek(event) {
  const rect = scrubber.getBoundingClientRect();
  const x = (event.touches ? event.touches[0].clientX : event.clientX) - rect.left;
  elapsed = Math.max(0, Math.min(1, x / rect.width)) * TIME.end;
  render(elapsed);
}

let isDragging = false;

scrubber.addEventListener("pointerdown", event => {
  isDragging = true;
  pause();
  seek(event);
  // Capture keeps the drag alive if the pointer leaves the scrubber.
  scrubber.setPointerCapture(event.pointerId);
});

scrubber.addEventListener("pointermove", event => {
  if (isDragging) seek(event);
});

scrubber.addEventListener("pointerup", () => {
  isDragging = false;
});

/* Keyboard transport: space toggles, the arrows step one second. */
document.addEventListener("keydown", event => {
  if (event.code === "Space") {
    event.preventDefault();   // stop the page scrolling instead
    isPlaying ? pause() : play();
  }
  if (event.code === "ArrowRight") {
    pause();
    elapsed = Math.min(TIME.end, elapsed + 1000);
    render(elapsed);
  }
  if (event.code === "ArrowLeft") {
    pause();
    elapsed = Math.max(0, elapsed - 1000);
    render(elapsed);
  }
});


/* ---------------------------------------------------------------------
 * 9. The explorers
 *
 * Once the walk-through is over the reader can move two things
 * independently, which is the point of separating the two quantities in
 * the first place:
 *
 *   the measured change   moves S, and leaves C untouched. A result is
 *                         as stable as it is; no amount of redescribing
 *                         the design makes a small effect firmer.
 *
 *   alpha and power       move C, and leave S untouched. A design can be
 *                         given the budget to justify a new mechanism by
 *                         demanding a stricter false positive rate, and
 *                         that decision is taken before any data exist.
 *
 * Both feed the same joint verdict chip, so the reader can find the
 * combination that actually licenses the claim: capacity at or above what
 * the mechanism costs, AND an effect stable enough to spend it on.
 * ------------------------------------------------------------------ */

/* The measured change. */
effectSlider.addEventListener("input", () => {
  currentObserved = parseFloat(effectSlider.value);
  const s = stabilityScore(currentObserved, THRESHOLD, REPLICATE_SD);

  sliderReadout.innerHTML =
    "Y fell by " + currentObserved.toFixed(1) + "% &nbsp;&rarr;&nbsp; S = "
    + s.toFixed(2);

  // Same three bands as the poster: act on it, look again, do not act.
  if (s >= 0.8)      sliderReadout.style.color = "#009E73";
  else if (s >= 0.5) sliderReadout.style.color = "#E69F00";
  else               sliderReadout.style.color = "#D55E00";

  drawPosterior(currentObserved, THRESHOLD, 2);
  drawCapacity(true);            // the verdict depends on S as well as C
});

/* The false positive rate. The slider position is log10(alpha), so a
 * given distance dragged is a given factor, not a given difference. */
alphaSlider.addEventListener("input", () => {
  currentAlpha = Math.pow(10, parseFloat(alphaSlider.value));
  alphaReadout.textContent = formatAlpha(currentAlpha);
  drawCapacity(true);
});

/* Statistical power. */
powerSlider.addEventListener("input", () => {
  currentPower = parseFloat(powerSlider.value);
  powerReadout.textContent = Math.round(currentPower * 100) + "%";
  drawCapacity(true);
});


/* ---------------------------------------------------------------------
 * 10. Start
 * ------------------------------------------------------------------ */
render(0);
updatePlayButton();

// A short pause before autoplay lets the page settle and fonts load, so
// the first turn animates in rather than appearing mid-reflow.
setTimeout(play, 700);

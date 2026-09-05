# dead drop

Move a file between two devices with no server, no internet, no accounts, and no
pairing — over sound, light, paper, vibration, or radio.

The point isn't efficiency. Nearby Share exists and it's better at being Nearby
Share. The point is that data will cross a gap through *anything* if you encode
it right, and watching it happen should feel like tradecraft. A phone blinking
its torch at another phone's camera at nine bits a second is not a good way to
move a file. It's a great way to move a file.

Everything here is written in-repo: the erasure code, the audio modem, the
optical codec, the QR encoder, the PDF writer, the crypto framing. Zero runtime
dependencies, 35 KB gzipped, works offline after first load.

## the one idea

**One payload pipeline, many transports.**

```
bytes → compress? → encrypt → chunk → LT fountain encode → frame → symbols → [transport]
bytes ← decompress ← decrypt ← reassemble ← LT decode ← deframe ← detect ← [transport]
```

A transport answers two questions: *how do I emit a symbol* and *how do I detect
one*. That's it. Chunking, loss recovery, integrity, and progress are shared, so
adding a ridiculous new channel is about 200 lines instead of a rewrite.

The consequence that makes it all work: **every channel is one-way and
connectionless.** The receiver never acknowledges anything. The transmitter emits
an endless stream of fountain-coded symbols, each one an XOR of a random subset
of the source blocks; the receiver collects until it has enough and stops caring
which ones it got. So you can point the camera away for ten seconds, walk out of
earshot, lose a third of the frames to a passing bus — it converges anyway.

That's also why you can join a transfer already in progress. There's no
handshake to have missed.

## transports

| codename | channel | rate | needs |
|---|---|---|---|
| `MORSE` | torch or screen → camera | 3.8–9 bit/s | camera |
| `HAPTIC` | vibration → accelerometer | ~3 bit/s | Android, devices touching |
| `CHIRP` | speaker → mic | 200–400 bit/s | mic |
| `LANTERN` | colour grid → camera | 18–34 kbit/s | camera, steady hands |
| `QR-CLASSIC` | animated QR → camera | 9–18 kbit/s | `BarcodeDetector` |
| `PAPER` | printer → camera | 12–24 KB/sheet | colour printer |
| `BLE` | Bluetooth GATT | ~8 kbit/s | a relay device — see below |
| `NFC` | NDEF tag | 240 B/tap | Android, blank tags |
| `LINK` | WebRTC, bootstrapped optically | MB/s | shared LAN or hotspot |
| `WIRE` | Web Serial | ~100 kbit/s | USB-serial on both ends |
| `MIRROR` | loopback / cross-tab | — | bench tool, dial your own loss |

Rates are what the code actually produces, not aspirations. Where a real number
disagreed with the spec I wrote down the real number — see `MORSE` below, which
is about seven times slower than the spec guessed.

### the clever one

`LINK` is the reason the slow channels earn their keep. WebRTC needs an SDP
offer and answer exchanged before a data channel opens, which normally means a
signalling server. Here the exchange rides over one of the other dead-drop
channels: the offer goes up on screen as a glyph grid, the other phone reads it
with its camera, the answer comes back the same way. Then megabytes a second
over the local network with no internet involved. ICE is pinned to host
candidates — no STUN, no TURN — so nothing ever leaves the LAN.

### ESCALATE

Start slow, upgrade mid-transfer, don't restart. Fountain symbols are
transport-agnostic, so the receiver just keeps collecting while the channel
changes underneath it. Measured going CHIRP → LANTERN: symbol count carried
straight through, 4 → 34, same session, same blocks.

One constraint the spec didn't mention and reality does: a symbol is a fixed
size, baked into the header and the decoder, so the new channel has to carry the
size already in flight. Faster channels almost always can — a 24×24 glyph will
happily carry an 8-byte MORSE symbol, it just wastes most of the frame doing it.
So escalating CHIRP's 48-byte symbols over LANTERN runs at 4.6 kbit/s rather
than LANTERN's native 18.4. Still eleven times faster than CHIRP.

## two places the spec meets the platform and loses

Both are written into the UI, not buried here.

**BLE can't be phone-to-phone.** The spec asks the transmitter to advertise a
GATT service and the receiver to connect. A browser cannot do that. Web
Bluetooth is central-only by design — there is no advertising API anywhere in
the platform. What works instead: both devices connect, as centrals, to the same
nearby peripheral running Nordic UART Service (an ESP32, a micro:bit), and it
relays. So it's a bridge and it needs a third piece of hardware.

**NFC can't be tap-to-transfer.** Android Beam is gone and Web NFC only reads
and writes tags. So instead of tapping two phones together you write symbols to
a cheap NTAG sticker and leave it somewhere. Which is, on reflection, more of a
dead drop than the original plan was.

## how the pieces work

**Fountain coding.** LT codes with a robust soliton degree distribution. Plain
peeling decode stalls near the end of a transfer — it only progresses while some
symbol has exactly one unknown neighbour, and running out of those costs 30–60%
extra traffic while you wait for a lucky one. So when peeling stalls the decoder
solves the residual system directly over GF(2) instead. Decoding then completes
as soon as the received symbols span the space, which is the information-theoretic
floor. Measured overhead: **0.8%** at K ≥ 300, 14% at K = 22 (small K is
rank-limited; nothing to be done about it).

Below 64 blocks the soliton distribution is too sparse to reach full rank
quickly, so half the symbols there use uniformly random degrees instead. Cut
overhead at K=22 from 25% to 14%.

**Framing.** `| magic 1B | seq 3B | payload B | crc16 2B |`. seq 0 carries header
fragments; everything else is an LT symbol seeded by its own sequence number. The
CRC decides whether a frame arrived; the fountain decides what that cost.

**Crypto.** 20-bit code → PBKDF2 → AES-GCM-256. Worth being blunt about the
threat model: this stops a *recording* of the transmission from being useful
without the code. It does not hide that a transmission happened, and it does
nothing about someone standing next to you reading the screen. A 20-bit code is
trivially brute-forceable offline. It buys you the length of the session.

The filename and mime type are encrypted too, so a recording doesn't announce
what was moved. On the very slow channels they're dropped entirely — on MORSE
the filename costs more airtime than the message.

**The audio modem.** 16-tone MFSK, 4 bits per symbol, continuous phase. The
preamble does two jobs: announces something is coming, and its alternation gives
the receiver a symbol clock without either end agreeing on a start time. A
separate start marker pins down where data begins, because "the preamble
stopped" is a fuzzy edge and an off-by-one symbol ruins a frame.

**The optical codec.** Not QR. QR spends most of its area on being findable from
any angle in a single shot; we control both ends and get thousands of shots, so
the area goes to payload instead. A frame is a white ring (the only thing
detection looks for), a black gap, and an N×N grid of cells in eight colours —
the corners of the RGB cube, so a cell is exactly 3 bits and each bit is one
channel above or below its own threshold. The top row carries all eight colours
in a known order, which is where those thresholds come from: white balance is
re-derived every single frame, so a warm room light or the phone's auto-WB
drifting mid-transfer costs nothing.

Detection is adaptive threshold → connected components → keep the ring-shaped
blobs → corners → homography → pick orientation from the calibration row →
sample. Multiple grids per image, because a printed sheet is a page full of them.

**MORSE and HAPTIC** share an on-off-keyed Manchester codec. Manchester because
these channels have no clock and no level reference: every bit carries its own
transition, so timing comes out of the signal itself, and the code is
DC-balanced, so "how bright is bright" can be a running average.

The thing that actually determines whether MORSE works is not brightness, it's
**camera frame rate**. The decoder needs about three readings per half-bit and
falls off a cliff below that — 0% recovery, not degraded recovery. So the modes
are named after the camera they need rather than the bit rate they achieve, and
the receiver measures its own frame rate and tells you when it's too slow.
Cameras slow down in the dark, which is exactly when you'd be using this.

This is also why the default mode is 3.8 bit/s rather than the 10–20 baud the
spec suggested: 20 baud needs a genuine 60 fps camera, and a phone in a dark
room is not running at 60 fps.

## what's actually been tested

Everything below runs in CI-able Node, no hardware:

```
npm test
```

- **LT round-trips** at 0 / 10 / 30 / 50% symbol loss, shuffled, with duplicates.
  Overhead measured, not assumed.
- **Determinism snapshot** on the `seq → block indices` mapping. It's a pure
  function and every receiver depends on it; an encoder change must not silently
  break them all.
- **Pipeline end-to-end** — including joining late, typing the key mid-transfer,
  20% frame corruption, and confirming a wrong key yields nothing at all.
- **Modem loopback** — synthesised tones through AWGN, BER swept by SNR. Usable
  down to −6 dB (audible) and −9 dB (ultrasonic) wideband SNR. Noise alone never
  produces a CRC-valid frame.
- **Optical loopback** — render a glyph, warp it through a homography, blur it,
  cast the colour, add noise, decode it. Nine distortion cases including 35°
  keystone and a 3px blur. Plus six tiles read out of one image.
- **Print and scan, for real** — generate the actual PDF, have poppler rasterise
  it at 150 and 200 dpi like a printer's RIP would, and read all 35 tiles back
  off the page. Skips if `pdftoppm` isn't installed.
- **QR encoder** — validated against published codeword capacities and byte-mode
  capacities, RS codewords checked to divide cleanly by the generator, format and
  version BCH codes checked for their designed minimum distances, and a
  round-trip through an independent structural reader. We ship an encoder, not a
  decoder; the decode side is the platform's `BarcodeDetector`.
- **OOK** — seeded, not random, because an unseeded version drops a frame one run
  in twelve and teaches you nothing.
- **The acceptance criteria above**, as assertions, so they can't quietly rot.

The UI was driven end-to-end in a real headless Chrome: two tabs, one
transmitting and one receiving over a cross-tab channel with 15% simulated loss,
through to `> DROP COMPLETE. INTEGRITY CONFIRMED.` and a byte-identical payload.

### the spec's acceptance criteria, measured

These run as tests, against real sessions, counting the frames the transmitter
actually emits — header retransmissions included, which are easy to forget and
are a tenth of CHIRP's airtime.

| criterion | target | measured |
|---|---|---|
| 1 KB of text by sound | < 40 s | **15.0 s** (37.5 s if incompressible) |
| 500 KB by LANTERN, handheld, 10 s look-away | < 5 min | **4.0 min** |
| a printed sheet photographed and decoded | works | **35/35 tiles** at 150 and 200 dpi |
| every transport degrades cleanly, nothing throws | required | **verified in-browser** |
| bundle | < 200 KB gzipped | **35 KB** |
| zero runtime dependencies | required | **zero** |
| fountain overhead at K ≥ 100 | ≤ 15% | **0.8%** (3.9% at K=128, 14% at K=22) |

One criterion the spec got wrong, and it's worth stating plainly: **MORSE is not
"a couple of minutes" for 200 bytes, it's 17.7.** A 26-byte message takes about
7 minutes through 10% frame loss. The arithmetic isn't subtle — 3.8 bit/s with
Manchester and a per-frame preamble is just slow — the estimate was optimistic.
Choosing 16-byte symbols instead of 8 cut that from 27.8 min to 17.7, and
24-byte symbols make it *worse* again (30.3 min) because at that size the header
crosses the threshold where it starts carrying a filename and a full digest and
needs an extra fragment. Non-monotonic cost curves are why you measure.

### field tests

**Not yet run.** Everything above is loopback and simulation. Two devices in a
room will find things that synthetic noise doesn't, and until that's happened
this table stays empty rather than getting filled with plausible numbers.

| codename | device pair | conditions | payload | achieved | notes |
|---|---|---|---|---|---|
| `CHIRP` | | | | | |
| `LANTERN` | | | | | |
| `MORSE` | | | | | |
| `PAPER` | | | | | |
| `LINK` | | | | | |

The app keeps its own ledger in IndexedDB — every completed drop, with transport,
size, duration, and achieved rate. That's where these numbers come from when
they exist. It's also the scoreboard: *"you have moved 3.2 MB by sound"* is a
better statistic than any transfer speed.

## running it

```
npm install
npm run dev      # http://localhost:5173
npm test
npm run build
```

Camera, microphone and Web Serial need a secure context — `localhost` counts, a
LAN IP doesn't. For two-device testing over the network, put it behind HTTPS or
use `MIRROR / CROSS-TAB`, which moves real symbols between two browser tabs and
is the closest thing to a second device without one.

## the aesthetic

Amber phosphor CRT, one accent colour doing all the emphasis, everything
monospaced, codenames instead of feature names, and status lines with dotted
leaders because six live numbers read faster that way than any dashboard does:

```
> TRANSPORT ........... LANTERN / 24x24 GRID
> SESSION KEY ......... 5348D
> PAYLOAD ............. photo.jpg  512,000 B  ->  2,731 BLOCKS
> RX LOCK ............. ████████░░  81%
> BLOCKS .............. 2,190 / 2,731
```

Per-transport live visuals are mandatory rather than decorative. A progress bar
tells you a transfer is working; a waterfall spectrogram tells you *why it isn't*.

No confetti. Completion is one line.

## still open

- **More than 8 colours in LANTERN?** 16 would roughly double the rate and needs
  much better calibration. It's a parameter now; someone should measure it.
- **Ultrasonic auto-fallback.** Plenty of phone speakers can't cleanly emit above
  ~18 kHz. The receiver could probe its actual response on the preamble and drop
  to the audible band by itself.
- **Relay mode.** Device B re-transmits what it received to device C over a
  different channel. Nearly free given the pipeline, and it turns two phones into
  a bucket brigade.
- **STEGO.** Payload in the low bits of an ordinary-looking photo. The most dead
  drop of all of them, and also a different project wearing this one's coat.

## structure

```
src/core/      pipeline, LT codes, framing, crypto, modem, OOK, DSP, ledger
src/glyph/     optical codec — layout, homography, detection, QR, PDF
src/transports/ one file per channel, plus shared camera/audio plumbing
src/ui/        the terminal
src/test/      node --test, no browser required
```

Zero runtime dependencies. Browser APIs only.

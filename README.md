# Activity Merger

A Windows desktop app that combines several recordings of the same workout (FIT, TCX or GPX) into one complete file. For example, take power, speed and route from Zwift and heart rate from a Garmin watch.

## Using it

1. **Add files.** Drag them onto the window or click **Add files…**. Any FIT/TCX/GPX from any app or device works.
2. **Check the data sources.** For each type of data (heart rate, power, cadence, speed, distance, GPS position, elevation, temperature) the app picks the file with the most data. Change it in **Data sources** if you like.
3. **Line up the clocks, if needed.** Each file has a **Time shift** (seconds). **Auto-align** finds the shift by matching a data type both files contain (heart rate, power, cadence or speed).
4. **Exceptions for a time range.** Drag across any chart to select a time range, then choose e.g. *Heart rate from None* (to drop a bad section) or from another file. Exceptions show as tinted bands in the charts.
5. **Time range.** Keep the main file's span, the part where all files overlap, everything, or trim to a selection. Greyed areas in the charts are left out.
6. **Options.** Set how large a gap gets filled by interpolation (watches often record every few seconds), where laps come from, and the activity type.
7. **Export.** Choose FIT (recommended for Strava, Garmin Connect, TrainingPeaks, intervals.icu), TCX or GPX, then click **Export…**.

Before uploading the merged file, delete the original activities from Strava / Garmin Connect, or you will end up with duplicates.

### Format notes
- **FIT** keeps everything, including laps and summary values (average/max, normalized power, kJ, ascent).
- **TCX** keeps heart rate, cadence, power, speed, distance, position, elevation and laps. Temperature is not part of TCX.
- **GPX** needs GPS positions. Heart rate, cadence and temperature use Garmin's extension, and power uses `<power>`, which Strava reads. There are no laps.

## Development

```bash
npm install
npm test            # core tests
npm run samples     # regenerate test/samples
npm start           # run the app
npm run dist:win    # build the Windows installer into release/
```

Code layout:
- `src/core/` – parsing (`parse.js`), merging, statistics and auto-align (`merge.js`), and FIT/TCX/GPX writers (`export.js`). This is plain JavaScript with no Electron dependency.
- `src/renderer/` – the UI (charts use uPlot). It also works in a normal browser, where it falls back to a file picker and downloads.
- `src/main/` – the Electron main process and preload (file dialogs).

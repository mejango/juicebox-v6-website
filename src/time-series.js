// Shape-preserving LTTB downsampling. First and latest observations are always
// retained, so a bounded chart can never become stale merely because its
// source collection grew.
export function downsampleTimeSeries(rows, maxPoints, xOf, yOf) {
  if (rows.length <= maxPoints) return rows.slice();
  if (maxPoints < 3) return [rows[0], rows[rows.length - 1]].slice(0, maxPoints);
  var sampled = [rows[0]];
  var width = (rows.length - 2) / (maxPoints - 2);
  var anchor = 0;
  var y = function (row) {
    var value = yOf(row);
    return Number.isFinite(value) ? value : 0;
  };
  for (var bucket = 0; bucket < maxPoints - 2; bucket++) {
    var avgStart = Math.floor((bucket + 1) * width) + 1;
    var avgEnd = Math.min(Math.floor((bucket + 2) * width) + 1, rows.length);
    var avgX = 0, avgY = 0;
    var count = Math.max(avgEnd - avgStart, 1);
    for (var i = avgStart; i < avgEnd; i++) {
      avgX += xOf(rows[i]);
      avgY += y(rows[i]);
    }
    avgX /= count; avgY /= count;
    var start = Math.floor(bucket * width) + 1;
    var end = Math.min(Math.floor((bucket + 1) * width) + 1, rows.length - 1);
    var selected = start, largest = -1;
    for (var cursor = start; cursor < end; cursor++) {
      var area = Math.abs(
        (xOf(rows[anchor]) - avgX) * (y(rows[cursor]) - y(rows[anchor]))
        - (xOf(rows[anchor]) - xOf(rows[cursor])) * (avgY - y(rows[anchor]))
      );
      if (area > largest) { largest = area; selected = cursor; }
    }
    sampled.push(rows[selected]);
    anchor = selected;
  }
  sampled.push(rows[rows.length - 1]);
  return sampled;
}

// Time-weighted display smoothing for exact post-trade pool spots. A price
// contributes only for the time it was actually in force, while the exact
// opening and latest values stay pinned to the line's endpoints.
export function smoothPriceSeries(points, maxBuckets) {
  maxBuckets = maxBuckets == null ? 96 : Number(maxBuckets);
  var sorted = (points || []).filter(function (point) {
    return point
      && Number.isFinite(Number(point.timestamp))
      && Number.isFinite(Number(point.value))
      && Number(point.value) > 0;
  }).map(function (point) {
    return { timestamp: Number(point.timestamp), value: Number(point.value) };
  }).sort(function (a, b) { return a.timestamp - b.timestamp; });

  var deduped = [];
  sorted.forEach(function (point) {
    if (deduped.length && deduped[deduped.length - 1].timestamp === point.timestamp) {
      deduped[deduped.length - 1] = point;
    } else {
      deduped.push(point);
    }
  });
  if (deduped.length < 4 || maxBuckets < 1) return deduped;

  var start = deduped[0].timestamp;
  var end = deduped[deduped.length - 1].timestamp;
  var duration = end - start;
  if (!(duration > 0)) return deduped;

  var bucketCount = Math.min(maxBuckets, Math.max(2, (deduped.length - 1) * 2));
  var bucketWidth = duration / bucketCount;
  var smoothed = [{ timestamp: start, value: deduped[0].value }];
  var eventIndex = 1;
  var currentValue = deduped[0].value;

  for (var bucket = 0; bucket < bucketCount; bucket++) {
    var bucketStart = start + bucket * bucketWidth;
    var bucketEnd = bucket === bucketCount - 1
      ? end
      : start + (bucket + 1) * bucketWidth;
    while (eventIndex < deduped.length && deduped[eventIndex].timestamp <= bucketStart) {
      currentValue = deduped[eventIndex].value;
      eventIndex++;
    }

    var cursor = bucketStart;
    var weightedTotal = 0;
    var nextIndex = eventIndex;
    var bucketValue = currentValue;
    while (nextIndex < deduped.length && deduped[nextIndex].timestamp < bucketEnd) {
      var event = deduped[nextIndex];
      weightedTotal += bucketValue * (event.timestamp - cursor);
      cursor = event.timestamp;
      bucketValue = event.value;
      nextIndex++;
    }
    weightedTotal += bucketValue * (bucketEnd - cursor);
    currentValue = bucketValue;
    eventIndex = nextIndex;
    smoothed.push({
      timestamp: bucketStart + (bucketEnd - bucketStart) / 2,
      value: weightedTotal / (bucketEnd - bucketStart),
    });
  }
  smoothed.push({ timestamp: end, value: deduped[deduped.length - 1].value });
  return smoothed;
}

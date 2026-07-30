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

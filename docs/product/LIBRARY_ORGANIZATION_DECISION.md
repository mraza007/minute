# Library organization decision

Decision: do not add tags or folders yet.

The current retrieval model is title/transcript search plus pinned, status,
source, date, and explicit sort controls. Adding two parallel taxonomies would
increase capture-time and cleanup work before there is evidence that search and
pinning fail.

Revisit when either condition is observed:

1. At least five users independently create naming conventions to simulate
   folders or request project grouping.
2. Large-library testing shows users cannot recover a known note within
   20 seconds using search, filters, sorting, and pinning.

If the threshold is met, test one lightweight concept first: a single optional
project label on a note. Do not implement nested folders and free-form tags at
the same time.

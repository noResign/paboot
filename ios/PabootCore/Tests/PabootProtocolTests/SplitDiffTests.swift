import XCTest
@testable import PabootProtocol

final class SplitDiffTests: XCTestCase {
    func testParsesHeadersContextAndPairedChanges() {
        let patch = """
        diff --git a/file.txt b/file.txt
        index 111..222 100644
        --- a/file.txt
        +++ b/file.txt
        @@ -1,4 +1,4 @@
         first
        -old one
        -old two
        +new one
        +new two
         last
        """

        let rows = SplitDiff.parse(patch)

        XCTAssertEqual(rows.count, 9)
        XCTAssertEqual(rows[0].kind, .meta)
        XCTAssertEqual(rows[0].fullText, "diff --git a/file.txt b/file.txt")
        XCTAssertEqual(rows[4].kind, .hunk)
        XCTAssertEqual(rows[4].fullText, "@@ -1,4 +1,4 @@")

        XCTAssertEqual(rows[5].kind, .lines)
        XCTAssertEqual(rows[5].oldLineNumber, 1)
        XCTAssertEqual(rows[5].newLineNumber, 1)
        XCTAssertEqual(rows[5].oldText, "first")
        XCTAssertEqual(rows[5].newText, "first")

        // Removed and added lines are paired into the same row.
        XCTAssertEqual(rows[6].oldLineNumber, 2)
        XCTAssertEqual(rows[6].newLineNumber, 2)
        XCTAssertEqual(rows[6].oldText, "old one")
        XCTAssertEqual(rows[6].newText, "new one")

        XCTAssertEqual(rows[7].oldLineNumber, 3)
        XCTAssertEqual(rows[7].newLineNumber, 3)
        XCTAssertEqual(rows[7].oldText, "old two")
        XCTAssertEqual(rows[7].newText, "new two")

        XCTAssertEqual(rows[8].oldLineNumber, 4)
        XCTAssertEqual(rows[8].newLineNumber, 4)
        XCTAssertEqual(rows[8].oldText, "last")
    }

    func testPairsMoreOldThanNewRowsWithNilSides() {
        let patch = """
        @@ -10,3 +10,1 @@
        -a
        -b
        -c
        +d
        """

        let rows = SplitDiff.parse(patch)

        XCTAssertEqual(rows.count, 4)
        XCTAssertEqual(rows[1].oldText, "a")
        XCTAssertEqual(rows[1].newText, "d")
        XCTAssertNil(rows[2].newText)
        XCTAssertNil(rows[3].newText)
        XCTAssertEqual(rows[3].oldLineNumber, 12)
    }

    func testHunkWithoutCountsAndNoNewlineMarker() {
        let patch = """
        @@ -5 +5 @@
        -old
        +new
        \\ No newline at end of file
        """

        let rows = SplitDiff.parse(patch)

        XCTAssertEqual(rows.count, 3)
        XCTAssertEqual(rows[0].kind, .hunk)
        XCTAssertEqual(rows[1].oldLineNumber, 5)
        XCTAssertEqual(rows[1].newLineNumber, 5)
        XCTAssertEqual(rows[1].oldText, "old")
        XCTAssertEqual(rows[1].newText, "new")
        XCTAssertEqual(rows[2].kind, .meta)
        XCTAssertEqual(rows[2].fullText, "\\ No newline at end of file")
    }

    func testAddedOnlyAndDeletedOnlyFiles() {
        let added = SplitDiff.parse(
            """
            --- /dev/null
            +++ b/new.txt
            @@ -0,0 +1,2 @@
            +one
            +two
            """
        )

        XCTAssertEqual(added.count, 5)
        XCTAssertEqual(added[3].oldLineNumber, 0)
        XCTAssertNil(added[3].oldText)
        XCTAssertEqual(added[3].newLineNumber, 1)
        XCTAssertEqual(added[3].newText, "one")
        XCTAssertEqual(added[4].newLineNumber, 2)
        XCTAssertEqual(added[4].newText, "two")

        let deleted = SplitDiff.parse(
            """
            --- a/old.txt
            +++ /dev/null
            @@ -1,1 +0,0 @@
            -gone
            """
        )

        XCTAssertEqual(deleted.count, 4)
        XCTAssertEqual(deleted[3].oldLineNumber, 1)
        XCTAssertEqual(deleted[3].oldText, "gone")
        XCTAssertNil(deleted[3].newText)
    }

    func testEmptyPatchProducesNoRows() {
        XCTAssertTrue(SplitDiff.parse("").isEmpty)
    }
}

"""Tests for speaker-labeled transcript merging and turn building."""

from src.transcriber import (
    build_labeled_turns,
    build_single_file_turns,
    merge_labeled_segments,
    relabel_turns,
)
from src.models import TranscriptTurn


class TestMergeLabeledSegments:
    def test_interleaves_by_start_time(self):
        system = [(0.0, 2.0, "Hello, how are you?"), (10.0, 12.0, "Great, talk later.")]
        mic = [(5.0, 7.0, "I'm good, thanks!")]
        result = merge_labeled_segments(system, mic)
        assert result == (
            "Them: Hello, how are you?\n"
            "Me: I'm good, thanks!\n"
            "Them: Great, talk later."
        )

    def test_joins_consecutive_same_speaker_segments(self):
        system = [(0.0, 1.5, "First part."), (2.0, 3.5, "Second part.")]
        mic = [(5.0, 6.5, "My reply.")]
        result = merge_labeled_segments(system, mic)
        assert result == "Them: First part. Second part.\nMe: My reply."

    def test_mic_only(self):
        result = merge_labeled_segments([], [(0.0, 2.0, "Just me talking.")])
        assert result == "Me: Just me talking."

    def test_system_only(self):
        result = merge_labeled_segments([(0.0, 2.0, "Just them talking.")], [])
        assert result == "Them: Just them talking."

    def test_empty_inputs(self):
        assert merge_labeled_segments([], []) == ""

    def test_skips_blank_segments(self):
        system = [(0.0, 1.0, "   "), (1.0, 2.0, "Real text.")]
        result = merge_labeled_segments(system, [])
        assert result == "Them: Real text."

    def test_strips_whitespace_from_segment_text(self):
        result = merge_labeled_segments([(0.0, 1.0, "  padded text  ")], [])
        assert result == "Them: padded text"


class TestBuildLabeledTurns:
    """Structured turn output from dual channel segments."""

    def test_turns_interleaved_by_start_time(self):
        system = [(0.0, 2.0, "Hello"), (10.0, 12.0, "Goodbye")]
        mic = [(5.0, 7.0, "Hi back")]
        turns = build_labeled_turns(system, mic)
        assert len(turns) == 3
        assert turns[0].speaker == "Them"
        assert turns[0].text == "Hello"
        assert turns[1].speaker == "Me"
        assert turns[1].text == "Hi back"
        assert turns[2].speaker == "Them"
        assert turns[2].text == "Goodbye"

    def test_turns_coalesce_consecutive_same_speaker(self):
        system = [(0.0, 1.5, "First."), (2.0, 3.5, "Second.")]
        mic = [(5.0, 6.5, "Reply.")]
        turns = build_labeled_turns(system, mic)
        assert len(turns) == 2
        assert turns[0].speaker == "Them"
        assert turns[0].text == "First. Second."
        assert turns[0].start == 0.0
        assert turns[0].end == 3.5  # max end of joined segments
        assert turns[1].speaker == "Me"
        assert turns[1].text == "Reply."

    def test_turn_start_is_first_segment_start(self):
        system = [(0.0, 1.0, "Part A"), (2.0, 4.0, "Part B")]
        turns = build_labeled_turns(system, [])
        assert turns[0].start == 0.0

    def test_turn_end_is_max_of_joined_segments(self):
        system = [(0.0, 3.0, "Part A"), (2.0, 5.0, "Part B")]
        turns = build_labeled_turns(system, [])
        assert turns[0].end == 5.0

    def test_flat_text_matches_turn_rendering(self):
        system = [(0.0, 2.0, "Hello."), (5.0, 8.0, "More them.")]
        mic = [(3.0, 4.0, "Hi from me.")]
        text = merge_labeled_segments(system, mic)
        turns = build_labeled_turns(system, mic)
        rendered = "\n".join(f"{t.speaker}: {t.text}" for t in turns)
        assert text == rendered

    def test_diarized_labels_in_turns(self):
        system = [(0.0, 2.0, "Hello."), (5.0, 8.0, "Goodbye.")]
        labels = ["Speaker 1", "Speaker 2"]
        turns = build_labeled_turns(system, [], labels)
        assert turns[0].speaker == "Speaker 1"
        assert turns[1].speaker == "Speaker 2"

    def test_empty_inputs_yield_empty_turns(self):
        assert build_labeled_turns([], []) == []

    def test_blank_segments_skipped_in_turns(self):
        system = [(0.0, 1.0, "   "), (1.0, 2.0, "Real.")]
        turns = build_labeled_turns(system, [])
        assert len(turns) == 1
        assert turns[0].text == "Real."


class TestBuildSingleFileTurns:
    """Turns for unlabeled single-file import transcripts."""

    def test_one_turn_per_segment(self):
        segs = [(0.0, 1.5, "Hello."), (2.0, 4.0, "World.")]
        turns = build_single_file_turns(segs)
        assert len(turns) == 2
        assert turns[0].speaker == "Them"
        assert turns[0].text == "Hello."
        assert turns[0].start == 0.0
        assert turns[0].end == 1.5
        assert turns[1].speaker == "Them"
        assert turns[1].text == "World."
        assert turns[1].start == 2.0
        assert turns[1].end == 4.0

    def test_blank_segments_filtered(self):
        segs = [(0.0, 1.0, "  ")]
        assert build_single_file_turns(segs) == []

    def test_empty_list(self):
        assert build_single_file_turns([]) == []


class TestRelabelTurns:
    """Turn speaker relabeling stays in sync with relabel_me."""

    def test_me_renamed_to_user_name(self):
        turns = [
            TranscriptTurn(speaker="Me", text="Hello.", start=0.0, end=1.0),
            TranscriptTurn(speaker="Them", text="Hi.", start=2.0, end=3.0),
            TranscriptTurn(speaker="Me", text="Bye.", start=4.0, end=5.0),
        ]
        result = relabel_turns(turns, "Hamza")
        assert result[0].speaker == "Hamza"
        assert result[1].speaker == "Them"
        assert result[2].speaker == "Hamza"
        # texts, starts, ends untouched
        for i in range(3):
            assert result[i].text == turns[i].text
            assert result[i].start == turns[i].start
            assert result[i].end == turns[i].end

    def test_none_label_is_noop(self):
        turns = [TranscriptTurn(speaker="Me", text="Hi.", start=0.0, end=1.0)]
        result = relabel_turns(turns, None)
        assert result[0].speaker == "Me"

    def test_blank_label_is_noop(self):
        turns = [TranscriptTurn(speaker="Me", text="Hi.", start=0.0, end=1.0)]
        result = relabel_turns(turns, "   ")
        assert result[0].speaker == "Me"

    def test_backslash_in_name(self):
        turns = [TranscriptTurn(speaker="Me", text="Hello.", start=0.0, end=1.0)]
        result = relabel_turns(turns, "CORP\\hamza")
        assert result[0].speaker == "CORP\\hamza"


class TestDiarizeSystemLabels:
    """The labeling layer above the diarizer: media gate + plumbing."""

    def test_playback_recording_skips_diarization(self, monkeypatch):
        # Mic bleed: the mic hears the same words the system channel plays —
        # the user is WATCHING something, so no "Speaker N" splitting at all.
        from src import diarizer
        from src.transcriber import diarize_system_labels

        def boom(*a, **k):  # the diarizer must never run for playback
            raise AssertionError("diarize() called despite the media gate")

        monkeypatch.setattr(diarizer, "diarize", boom)
        sentence = "the sovereign assistant answers every question locally today"
        system = [(0.0, 5.0, sentence), (8.0, 13.0, sentence)]
        mic = [(0.5, 5.5, sentence)]  # speaker bleed into the mic
        assert diarize_system_labels("sys.wav", system, True, mic) is None

    def test_meeting_recording_diarizes_with_voiced_starts(self, monkeypatch):
        # Distinct two-way conversation → gate stays open; the diarizer gets
        # the transcribed segment starts so unvoiced turns can be dropped.
        from src import diarizer
        from src.transcriber import diarize_system_labels

        seen: dict = {}

        def fake_diarize(path, voiced_starts=None):
            seen["path"] = path
            seen["voiced_starts"] = voiced_starts
            return [(0.0, 9.0, 0), (9.0, 20.0, 3)]

        monkeypatch.setattr(diarizer, "diarize", fake_diarize)
        system = [(0.0, 4.0, "Quarterly numbers look strong overall."),
                  (10.0, 14.0, "Marketing budget needs another review.")]
        mic = [(5.0, 8.0, "Thanks everyone for joining the planning call.")]
        labels = diarize_system_labels("sys.wav", system, True, mic)
        assert labels == ["Speaker 1", "Speaker 2"]
        assert seen["path"] == "sys.wav"
        assert seen["voiced_starts"] == [0.0, 10.0]

    def test_gate_absent_without_mic_segments(self, monkeypatch):
        # No mic context (e.g. older callers) → gate is skipped, diarization runs.
        from src import diarizer
        from src.transcriber import diarize_system_labels

        monkeypatch.setattr(
            diarizer, "diarize", lambda p, voiced_starts=None: [(0.0, 5.0, 0), (5.0, 9.0, 1)]
        )
        system = [(0.0, 2.0, "hello there"), (6.0, 8.0, "general kenobi")]
        labels = diarize_system_labels("sys.wav", system, True)
        assert labels == ["Speaker 1", "Speaker 2"]


class TestStripMicBleed:
    """Mic segments duplicating temporally-close system segments are speaker
    bleed, not the user talking — they must not enter the transcript."""

    def _strip(self, system, mic):
        from src.transcriber import strip_mic_bleed

        return strip_mic_bleed(system, mic)

    def test_verbatim_bleed_dropped(self):
        system = [(0.0, 3.0, "Andrej Karpathy released the idea of the LLM Wiki.")]
        mic = [(1.2, 4.0, "Andrej Karpathy released the idea of the LLM wiki")]
        assert self._strip(system, mic) == []

    def test_near_verbatim_bleed_dropped(self):
        # Whisper transcribes the bleed slightly differently on each channel.
        system = [(10.0, 13.0, "Users can copy the markdown file into a coding engine.")]
        mic = [(11.5, 14.0, "Users can copy the markdown file into coding engine")]
        assert self._strip(system, mic) == []

    def test_genuine_user_speech_kept(self):
        system = [(0.0, 3.0, "Today we cover the borrow checker rules in detail.")]
        mic = [(2.0, 5.0, "I should try this pattern in the Adversaria project.")]
        assert self._strip(system, mic) == mic

    def test_same_words_far_apart_in_time_kept(self):
        # The user quoting the video a minute later is speech, not bleed.
        system = [(0.0, 3.0, "The original gist achieved forty thousand stars.")]
        mic = [(65.0, 68.0, "The original gist achieved forty thousand stars.")]
        assert self._strip(system, mic) == mic

    def test_short_interjections_kept(self):
        # Under the 3-word floor there's too little signal to call it bleed.
        system = [(0.0, 1.0, "Okay then.")]
        mic = [(0.5, 1.5, "Okay then.")]
        assert self._strip(system, mic) == mic

    def test_mixed_keeps_only_user_lines(self):
        system = [
            (0.0, 3.0, "Welcome back to the channel everyone."),
            (5.0, 8.0, "Today we are building a trading bot."),
        ]
        mic = [
            (0.8, 3.5, "Welcome back to the channel everyone."),
            (7.0, 10.0, "Hmm, I could use this for the Tatweer dashboard project."),
        ]
        assert self._strip(system, mic) == [mic[1]]

    def test_empty_inputs_passthrough(self):
        mic = [(0.0, 2.0, "Solo brainstorm with nothing playing on the system side.")]
        assert self._strip([], mic) == mic
        assert self._strip([(0.0, 2.0, "video audio")], []) == []

    def test_end_times_preserved_through_strip(self):
        """Bleed stripping must preserve the end times of kept segments."""
        system = [(0.0, 3.0, "Welcome to the channel.")]
        mic = [
            (0.5, 3.5, "Welcome to the channel."),  # bleed
            (5.0, 8.0, "My genuine observation here."),  # kept
        ]
        result = self._strip(system, mic)
        assert result == [(5.0, 8.0, "My genuine observation here.")]

    def test_garbled_duplicate_caught_by_containment(self):
        # Ordered ratio may fall under 0.85, but token containment >= 0.8 catches it.
        system = [(0.0, 3.0, "for example here is the record button that I demonstrated here")]
        mic = [(1.0, 4.0, "for example here is the record button that I showed")]
        assert self._strip(system, mic) == []

    def test_exact_3_word_duplicate_dropped(self):
        system = [(0.0, 2.0, "yeah sounds good")]
        mic = [(0.5, 2.5, "yeah sounds good")]
        assert self._strip(system, mic) == []

    def test_non_duplicate_3_word_kept(self):
        system = [(0.0, 2.0, "quarterly numbers look strong")]
        mic = [(1.0, 3.0, "no I disagree")]
        assert self._strip(system, mic) == mic


class TestStripGlossaryEcho:
    """Glossary echo: Whisper repeats the vocabulary initial_prompt back as text."""

    def _strip(self, segments, prompt=None):
        from src.transcriber import strip_glossary_echo

        return strip_glossary_echo(segments, prompt)

    def test_shuffled_repeated_echo_dropped(self):
        seg = [(0.0, 3.0, "Tatweer OS, Echelon, Tatweer, Echelon, Tatweer Tatweer OS, Echelon, Tatweer")]
        prompt = "Glossary: Tatweer OS, Claude, Hira, Laghari, Echelon, Tatweer"
        assert self._strip(seg, prompt) == []

    def test_real_sentence_mentioning_one_term_kept(self):
        seg = [(0.0, 2.0, "so Tatweer OS organizes everything for you")]
        prompt = "Glossary: Tatweer OS, Claude, Hira, Laghari, Echelon, Tatweer"
        assert self._strip(seg, prompt) == seg

    def test_mixed_segment_prefix_trimmed(self):
        seg = [(1.0, 5.0, "Tatweer OS, Echelon, Tatweer it organizes everything for you so for example here is the record button")]
        prompt = "Glossary: Tatweer OS, Claude, Hira, Laghari, Echelon, Tatweer"
        result = self._strip(seg, prompt)
        assert len(result) == 1
        assert result[0][0] == 1.0  # start preserved
        assert result[0][1] == 5.0  # end preserved
        assert result[0][2] == "it organizes everything for you so for example here is the record button"

    def test_no_vocabulary_passthrough(self):
        seg = [(0.0, 2.0, "Tatweer OS, Echelon, Tatweer")]
        assert self._strip(seg, None) == seg
        assert self._strip(seg, "") == seg

    def test_glossary_literal_token_dropped(self):
        seg = [(0.0, 2.0, "Glossary: Tatweer OS, Claude")]
        prompt = "Glossary: Tatweer OS, Claude"
        assert self._strip(seg, prompt) == []
    """Mic segments with no real voice are Whisper hallucinations on a silent
    mic ("thanks for watching", repetition loops) — they must not become the
    user's talk-time. VAD marks the voiced spans; only overlapping segments stay."""

    def _keep(self, mic, voiced):
        from src.transcriber import keep_voiced_segments

        return keep_voiced_segments(mic, voiced)

    def test_hallucination_over_silence_dropped(self):
        # A 30s "thanks for watching" (Norwegian) over a region VAD found silent.
        mic = [(120.0, 150.0, "Takk for at du så på.")]
        voiced = [(0.0, 5.0), (200.0, 210.0)]
        assert self._keep(mic, voiced) == []

    def test_real_speech_over_voice_kept(self):
        mic = [(10.0, 14.0, "I think we should ship the fix this week.")]
        voiced = [(9.5, 15.0)]
        assert self._keep(mic, voiced) == mic

    def test_silent_mic_drops_everything(self):
        # The user only listened — every mic segment is a hallucination.
        mic = [(0.0, 16.8, "God of God God of God"), (120.0, 150.0, "Takk.")]
        assert self._keep(mic, []) == []

    def test_partial_overlap_below_floor_dropped(self):
        mic = [(10.0, 13.0, "spurious")]
        voiced = [(9.9, 10.2)]  # only 0.2s voiced — below the 0.5s floor
        assert self._keep(mic, voiced) == []

    def test_partial_overlap_above_floor_kept(self):
        mic = [(10.0, 13.0, "yeah that makes sense to me")]
        voiced = [(9.0, 11.0)]  # 1.0s overlap >= 0.5s floor
        assert self._keep(mic, voiced) == mic

    def test_end_times_preserved(self):
        mic = [(5.0, 9.0, "kept line"), (120.0, 150.0, "hallucination")]
        voiced = [(4.0, 10.0)]
        assert self._keep(mic, voiced) == [(5.0, 9.0, "kept line")]


class TestSystemTrackVadGate:
    """A silent SYSTEM track makes Whisper echo the custom-vocabulary
    `initial_prompt` back as a "transcription" ("Tatweer OS, Echelon, Tatweer")
    — the same hallucination mode the mic gate already blocks. Both dual paths
    route through `_merge_dual`, so the gate must apply to the system channel
    there too (2026-07-16 user report)."""

    @staticmethod
    def _wavs(tmp_path):
        sys_wav = tmp_path / "system.wav"
        mic_wav = tmp_path / "mic.wav"
        sys_wav.write_bytes(b"RIFF")  # _merge_dual only checks existence
        mic_wav.write_bytes(b"RIFF")
        return str(sys_wav), str(mic_wav)

    def test_prompt_echo_on_silent_system_dropped(self, tmp_path, monkeypatch):
        import src.transcriber as tr

        sys_path, mic_path = self._wavs(tmp_path)

        def collect(path):
            if path == sys_path:
                # Whisper on silence: echoes the vocabulary prompt verbatim.
                echo = [(0.0, 2.0, "Tatweer OS, Echelon, Tatweer")]
                return echo, tr._TranscriptInfo("en", 7.0)
            return [], tr._TranscriptInfo("en", 7.0)

        monkeypatch.setattr(tr, "_voiced_regions", lambda path: [])  # no voice anywhere
        resp = tr._merge_dual(collect, sys_path, mic_path, diarize=False)
        assert resp.turns == []
        assert resp.text == ""

    def test_real_system_speech_kept(self, tmp_path, monkeypatch):
        import src.transcriber as tr

        sys_path, mic_path = self._wavs(tmp_path)

        def collect(path):
            if path == sys_path:
                real = [(0.0, 3.0, "Quarterly numbers look strong across regions.")]
                return real, tr._TranscriptInfo("en", 3.0)
            return [], tr._TranscriptInfo("en", 3.0)

        monkeypatch.setattr(tr, "_voiced_regions", lambda path: [(0.0, 3.5)])
        resp = tr._merge_dual(collect, sys_path, mic_path, diarize=False)
        assert "Quarterly numbers look strong across regions." in resp.text


class TestPlaybackHint:
    """The pre-strip verdict: bleed-heavy channels mean the user was WATCHING."""

    def test_bleed_heavy_recording_hints_youtube(self):
        from src.transcriber import playback_hint

        video = [
            "the original gist achieved forty thousand stars overnight",
            "users can copy the markdown file into a coding engine",
            "the system incrementally builds a persistent wiki from sources",
        ]
        system = [(float(i * 8), float(i * 8 + 5), text) for i, text in enumerate(video)]
        mic = [(float(i * 8) + 0.7, float(i * 8 + 5) + 0.7, text) for i, text in enumerate(video)]  # bleed
        assert playback_hint(system, mic) == "youtube"

    def test_real_conversation_hints_nothing(self):
        from src.transcriber import playback_hint

        system = [(0.0, 3.0, "Quarterly numbers look strong across every region.")]
        mic = [(5.0, 8.0, "Great, then let's bring the launch forward two weeks.")]
        assert playback_hint(system, mic) is None

    def test_missing_channel_hints_nothing(self):
        from src.transcriber import playback_hint

        assert playback_hint([], [(0.0, 2.0, "solo brainstorm words")]) is None
        assert playback_hint([(0.0, 2.0, "video only")], []) is None

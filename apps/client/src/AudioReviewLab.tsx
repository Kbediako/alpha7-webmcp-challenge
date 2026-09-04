import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Pause, Play, Square } from "lucide-react";
import { AUDIO_REVIEW_GROUPS, type AudioCueDefinition } from "./audioCatalog";

export function AudioReviewLab() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [activeCueId, setActiveCueId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const stop = () => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
    }
    setActiveCueId(null);
  };

  const play = (cue: AudioCueDefinition) => {
    const audio = audioRef.current;
    if (!audio) return;
    if (activeCueId === cue.id && !audio.paused) {
      audio.pause();
      setActiveCueId(null);
      return;
    }

    setError("");
    audio.pause();
    audio.src = cue.src;
    audio.loop = cue.loop;
    audio.volume = Math.min(1, cue.volume * 1.6);
    audio.currentTime = 0;
    void audio
      .play()
      .then(() => setActiveCueId(cue.id))
      .catch(() => {
        setActiveCueId(null);
        setError(`Could not play ${cue.label}. Check that the generated asset is present.`);
      });
  };

  useEffect(
    () => () => {
      const audio = audioRef.current;
      if (audio) audio.pause();
    },
    []
  );

  return (
    <main className="audio-review-lab">
      <audio
        onEnded={() => setActiveCueId(null)}
        preload="metadata"
        ref={audioRef}
      />
      <header className="audio-review-header">
        <div>
          <span className="audio-review-kicker">Alpha-7 / Sound design</span>
          <h1>Audio review lab</h1>
          <p>Play each cue in isolation. Music, movement, and rain loop until stopped; weapons, UI, and thunder are one-shots.</p>
        </div>
        <div className="audio-review-actions">
          <button className="secondary-button" disabled={!activeCueId} onClick={stop} type="button">
            <Square size={16} />
            Stop all
          </button>
          <a className="secondary-button" href="/">
            <ArrowLeft size={16} />
            Back to game
          </a>
        </div>
      </header>

      {error ? <p className="audio-review-error" role="alert">{error}</p> : null}

      <div className="audio-review-groups">
        {AUDIO_REVIEW_GROUPS.map((group) => (
          <section className="audio-review-group" key={group.id}>
            <div className="audio-review-group-heading">
              <span>{group.eyebrow}</span>
              <h2>{group.title}</h2>
            </div>
            <div className="audio-review-grid">
              {group.cues.map((cue) => {
                const active = activeCueId === cue.id;
                return (
                  <article className={active ? "audio-cue-card is-playing" : "audio-cue-card"} key={cue.id}>
                    <button
                      aria-label={`${active ? "Pause" : "Play"} ${cue.label}`}
                      aria-pressed={active}
                      className="audio-cue-play"
                      data-audio-id={cue.id}
                      onClick={() => play(cue)}
                      type="button"
                    >
                      {active ? <Pause size={20} /> : <Play size={20} />}
                    </button>
                    <div>
                      <strong>{cue.label}</strong>
                      <p>{cue.description}</p>
                      <span>{cue.loop ? "Seamless loop" : "One-shot"}</span>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}

# v7 Calibration Sample (stratified ~300 verbatims)

Adjudicate each verbatim by editing the `must_include`, `may_include`, and `must_not_include` fields per framework. The calibration runner (`bin/test_framework_regression.py` or the offline variant) will compute per-tag precision/recall from your annotations.

Each fixture entry was pre-populated with the current v7 tags. If those tags are correct, copy them into `must_include`. If any is wrong, move it into `must_not_include`. Add any tags v7 missed.

```yaml
fixtures:
  - id: 196
    stratum: 'over_firer:joy_modes:inspirational'
    excerpt: "I would expect to have an amazing experience fillet with beautiful beaches, delicious food, and rich culture. I would lo"
    question: "What kind of experience would you expect if you took a vacation to Puerto Rico?"
    v7_current:
      joy_modes: [hedonic, aesthetic, inspirational]
      tensions: []
      functional_jobs: [learn_grow]
      occasions: [vacation, anticipation]
    expected:
      joy_modes:
        must_include: [hedonic, aesthetic, inspirational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [learn_grow]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [vacation, anticipation]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 2075
    stratum: 'over_firer:joy_modes:inspirational'
    excerpt: "A laptop let discover so many new things transported to so many new locations I couldn't go"
    question: "What are some things in your life ‚Äì products, services or experiences you have purchased ‚Äì that have brought you joy"
    v7_current:
      joy_modes: [inspirational, freedom]
      tensions: []
      functional_jobs: [learn_grow]
      occasions: [post_purchase]
    expected:
      joy_modes:
        must_include: [inspirational, freedom]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [learn_grow]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [post_purchase]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 3705
    stratum: 'over_firer:joy_modes:inspirational'
    excerpt: "My kindle, I love to read, it is so relaxing to me, it is like a vacation in your mind as you experience the book."
    question: "What are some things in your life ‚Äì products, services or experiences you have purchased ‚Äì that have brought you joy"
    v7_current:
      joy_modes: [tranquil, hedonic, inspirational]
      tensions: []
      functional_jobs: [immerse_in_story, relax_recover]
      occasions: [post_purchase, alone_time]
    expected:
      joy_modes:
        must_include: [tranquil, hedonic, inspirational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [immerse_in_story, relax_recover]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [post_purchase, alone_time]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 4481
    stratum: 'over_firer:joy_modes:inspirational'
    excerpt: "An experience of seeing aircraft fly and learn more about space exploration."
    question: "What kind of experience would you expect if you visited Kennedy Space Center Visitor Complex?"
    v7_current:
      joy_modes: [inspirational, awe]
      tensions: []
      functional_jobs: [learn_grow, immerse_in_story]
      occasions: []
    expected:
      joy_modes:
        must_include: [inspirational, awe]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [learn_grow, immerse_in_story]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 4971
    stratum: 'over_firer:joy_modes:inspirational'
    excerpt: "I recall seeing an ad that PETA had placed on Facebook and it recapped the year and all the accomplishments they had suc"
    question: "TOM_Ad"
    v7_current:
      joy_modes: [inspirational]
      tensions: []
      functional_jobs: [learn_grow]
      occasions: []
    expected:
      joy_modes:
        must_include: [inspirational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [learn_grow]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 6532
    stratum: 'over_firer:joy_modes:inspirational'
    excerpt: "Good guided tour with uplifting  information about space and the center"
    question: "What kind of experience would you expect if you visited Kennedy Space Center Visitor Complex?"
    v7_current:
      joy_modes: [inspirational, awe]
      tensions: []
      functional_jobs: [learn_grow]
      occasions: []
    expected:
      joy_modes:
        must_include: [inspirational, awe]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [learn_grow]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 7689
    stratum: 'over_firer:joy_modes:inspirational'
    excerpt: "I would expect to learn more about the history of the American space program, including a high level overview of the sci"
    question: "What kind of experience would you expect if you visited Kennedy Space Center Visitor Complex?"
    v7_current:
      joy_modes: [inspirational]
      tensions: []
      functional_jobs: [learn_grow]
      occasions: []
    expected:
      joy_modes:
        must_include: [inspirational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [learn_grow]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 8416
    stratum: 'over_firer:joy_modes:inspirational'
    excerpt: "I would like to see the spacecrafts and read the stories of the astronauts."
    question: "What kind of experience would you expect if you visited Kennedy Space Center Visitor Complex?"
    v7_current:
      joy_modes: [inspirational, awe]
      tensions: []
      functional_jobs: [immerse_in_story, learn_grow]
      occasions: [anticipation]
    expected:
      joy_modes:
        must_include: [inspirational, awe]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [immerse_in_story, learn_grow]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [anticipation]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 9790
    stratum: 'over_firer:joy_modes:inspirational'
    excerpt: "Gatorade. It was a captivating commercial,  showing athletes doing amazing things after drinking Gatorade."
    question: "TOM_Ad"
    v7_current:
      joy_modes: [inspirational, physical]
      tensions: []
      functional_jobs: [immerse_in_story]
      occasions: []
    expected:
      joy_modes:
        must_include: [inspirational, physical]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [immerse_in_story]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 11017
    stratum: 'over_firer:joy_modes:inspirational'
    excerpt: "An astronomical one I love space and space oriented things"
    question: "What kind of experience would you expect if you visited Kennedy Space Center Visitor Complex?"
    v7_current:
      joy_modes: [awe, inspirational]
      tensions: []
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: [awe, inspirational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 12072
    stratum: 'over_firer:joy_modes:inspirational'
    excerpt: "I love going to Europe. love the culture and history"
    question: "Let's talk about vacations! If you could travel anywhere in the world, what destination would bring you the most joy? Wh"
    v7_current:
      joy_modes: [inspirational, awe]
      tensions: []
      functional_jobs: []
      occasions: [anticipation, vacation]
    expected:
      joy_modes:
        must_include: [inspirational, awe]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [anticipation, vacation]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 12757
    stratum: 'over_firer:joy_modes:inspirational'
    excerpt: "The understanding of how going into space is rewarding"
    question: "What kind of experience would you expect if you visited Kennedy Space Center Visitor Complex?"
    v7_current:
      joy_modes: [inspirational, achievement]
      tensions: []
      functional_jobs: [learn_grow]
      occasions: []
    expected:
      joy_modes:
        must_include: [inspirational, achievement]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [learn_grow]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 4761
    stratum: 'over_firer:tensions:present_vs_future'
    excerpt: "The stress of trying to survive. Can't afford anything, probably never will. I will never be able to enjoy life because "
    question: "What do you think has been making you feel less joyful than usual?"
    v7_current:
      joy_modes: []
      tensions: [present_vs_future, control_vs_surrender]
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [present_vs_future, control_vs_surrender]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 8717
    stratum: 'over_firer:tensions:present_vs_future'
    excerpt: "I had to buy a new starter for my ford vehicle. It did not bring me joy to spend that much money before summer. It took "
    question: "What's an example of something you purchased that definitely did NOT bring you joy? What was it, from what brand or comp"
    v7_current:
      joy_modes: []
      tensions: [present_vs_future, self_vs_others]
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [present_vs_future, self_vs_others]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 18933
    stratum: 'over_firer:tensions:present_vs_future'
    excerpt: "Waiting to start a job and trying to find jobs has been tough in the new state of Florida. We want to be able to support"
    question: "What do you think has been making you feel less joyful than usual?"
    v7_current:
      joy_modes: []
      tensions: [present_vs_future]
      functional_jobs: [provide_security]
      occasions: []
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [present_vs_future]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [provide_security]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 20440
    stratum: 'over_firer:tensions:present_vs_future'
    excerpt: "I would love to visit the private gemstone mines that offer to purchase what you find. I love exploring and searching fo"
    question: "Let's talk about vacations! If you could travel anywhere in the world, what destination would bring you the most joy? Wh"
    v7_current:
      joy_modes: [playful, inspirational]
      tensions: [present_vs_future]
      functional_jobs: [escape_routine, learn_grow]
      occasions: [vacation, anticipation]
    expected:
      joy_modes:
        must_include: [playful, inspirational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [present_vs_future]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [escape_routine, learn_grow]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [vacation, anticipation]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 25243
    stratum: 'over_firer:tensions:present_vs_future'
    excerpt: "I think my greatest joy after retirement is the idea that I can read as much as I want to. Reading has always been a hig"
    question: "What are some brands, products, services or experiences you have purchased that have brought you joy? Please tell us abo"
    v7_current:
      joy_modes: [inspirational, tranquil]
      tensions: [present_vs_future]
      functional_jobs: [relax_recover, learn_grow]
      occasions: [everyday, post_purchase]
    expected:
      joy_modes:
        must_include: [inspirational, tranquil]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [present_vs_future]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [relax_recover, learn_grow]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [everyday, post_purchase]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 30051
    stratum: 'over_firer:tensions:present_vs_future'
    excerpt: "Pros are you don't have to worry about being stuck in the kitchen cooking for long periods of time. Another pro is you d"
    question: "What are the pros and cons of going out to a restaurant vs. eating at home?"
    v7_current:
      joy_modes: []
      tensions: [present_vs_future, luxury_vs_value]
      functional_jobs: [relax_recover]
      occasions: []
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [present_vs_future, luxury_vs_value]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [relax_recover]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 32297
    stratum: 'over_firer:tensions:present_vs_future'
    excerpt: "I stress eat. It makes me feel better but has long term consequences."
    question: "When you are stressed, what are some things you do - or buy - to bring joy back into your life? And why does that work f"
    v7_current:
      joy_modes: [hedonic]
      tensions: [present_vs_future]
      functional_jobs: [relax_recover]
      occasions: []
    expected:
      joy_modes:
        must_include: [hedonic]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [present_vs_future]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [relax_recover]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 40853
    stratum: 'over_firer:tensions:present_vs_future'
    excerpt: "I will watch with friends. I have been invited to watch live in New Orleans but I am too busy with work."
    question: "How do you celebrate/watch/enjoy the Superbowl? What are some of your big game traditions?"
    v7_current:
      joy_modes: []
      tensions: [present_vs_future]
      functional_jobs: [cheer_team, share_experience]
      occasions: [live_event, anticipation]
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [present_vs_future]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [cheer_team, share_experience]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [live_event, anticipation]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 41888
    stratum: 'over_firer:tensions:present_vs_future'
    excerpt: "First, I am looking forward to Jehovah's Kingdom/government to soon end Satan's wicked system and then Jehovah will resu"
    question: "How are you feeling about 2026 so far?"
    v7_current:
      joy_modes: [spiritual, inspirational]
      tensions: [present_vs_future]
      functional_jobs: []
      occasions: [anticipation]
    expected:
      joy_modes:
        must_include: [spiritual, inspirational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [present_vs_future]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [anticipation]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 44416
    stratum: 'over_firer:tensions:present_vs_future'
    excerpt: "I make my own plan. For now I am doing okay. The future worries me."
    question: "How does having a financial plan in place make you feel?"
    v7_current:
      joy_modes: []
      tensions: [present_vs_future]
      functional_jobs: [plan_future]
      occasions: []
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [present_vs_future]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [plan_future]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 45758
    stratum: 'over_firer:tensions:present_vs_future'
    excerpt: "I drink, read and pet my cat. Yes, that brings ne joy, but when a wake up in the morning, the orange maniac is still the"
    question: "When you are stressed, what are some things you do - or buy - to bring joy back into your life? And why does that work f"
    v7_current:
      joy_modes: [hedonic, relational, tranquil]
      tensions: [present_vs_future]
      functional_jobs: [relax_recover, relieve_anxiety]
      occasions: [everyday]
    expected:
      joy_modes:
        must_include: [hedonic, relational, tranquil]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [present_vs_future]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [relax_recover, relieve_anxiety]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [everyday]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 60297
    stratum: 'over_firer:tensions:present_vs_future'
    excerpt: "Comfortable but dissatisfied with how difficult work is. Hopeful but scared about finding a new job."
    question: "How are you feeling about 2026 so far?"
    v7_current:
      joy_modes: []
      tensions: [aspiration_vs_acceptance, present_vs_future]
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [aspiration_vs_acceptance, present_vs_future]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 1530
    stratum: 'over_firer:tensions:aspiration_vs_acceptance'
    excerpt: "Laptop, television and clothes and it brought me joy because I was able to purchase it even though I am not financially "
    question: "What are some things in your life ‚Äì products, services or experiences you have purchased ‚Äì that have brought you joy"
    v7_current:
      joy_modes: [achievement]
      tensions: [aspiration_vs_acceptance]
      functional_jobs: [feel_proud]
      occasions: [post_purchase]
    expected:
      joy_modes:
        must_include: [achievement]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [aspiration_vs_acceptance]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [feel_proud]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [post_purchase]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 6523
    stratum: 'over_firer:tensions:aspiration_vs_acceptance'
    excerpt: "I was very happy to see that Dove products are now cruelty free; made me fell positive and happy. If a big company like "
    question: "TOM_Ad"
    v7_current:
      joy_modes: [inspirational]
      tensions: [aspiration_vs_acceptance]
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: [inspirational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [aspiration_vs_acceptance]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 10382
    stratum: 'over_firer:tensions:aspiration_vs_acceptance'
    excerpt: "I recently bought a new refrigerator. It is a LG French Door with bottom freezer. I have wanted one for years and I love"
    question: "What's a recent example of a time you purchased something that brought you joy? What was it, from what brand or company "
    v7_current:
      joy_modes: [hedonic]
      tensions: [aspiration_vs_acceptance]
      functional_jobs: [reward_self]
      occasions: [post_purchase]
    expected:
      joy_modes:
        must_include: [hedonic]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [aspiration_vs_acceptance]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [reward_self]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [post_purchase]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 13660
    stratum: 'over_firer:tensions:aspiration_vs_acceptance'
    excerpt: "I don't know the names of any beaches because I can't afford to go anywhere."
    question: "If you could vacation at ANY BEACH DESTINATION, which one would you choose? Why?"
    v7_current:
      joy_modes: []
      tensions: [aspiration_vs_acceptance]
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [aspiration_vs_acceptance]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 22736
    stratum: 'over_firer:tensions:aspiration_vs_acceptance'
    excerpt: "I'd like to travel to Dubai before I leave this planet.  Everything I run across makes it seem luxurious and more innova"
    question: "Let's talk about vacations! If you could travel anywhere in the world, what destination would bring you the most joy? Wh"
    v7_current:
      joy_modes: [awe]
      tensions: [aspiration_vs_acceptance]
      functional_jobs: []
      occasions: [anticipation, vacation]
    expected:
      joy_modes:
        must_include: [awe]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [aspiration_vs_acceptance]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [anticipation, vacation]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 28601
    stratum: 'over_firer:tensions:aspiration_vs_acceptance'
    excerpt: "Nashville, always wanted to go and visit the Grand Ole Opry and the Ryman and all the honky-tonks .  Was suppose to go f"
    question: "Let's talk about vacations! If you could travel anywhere in the world, what destination would bring you the most joy? Wh"
    v7_current:
      joy_modes: [sentimental, inspirational]
      tensions: [aspiration_vs_acceptance]
      functional_jobs: [create_memory]
      occasions: [anticipation, birthday]
    expected:
      joy_modes:
        must_include: [sentimental, inspirational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [aspiration_vs_acceptance]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [create_memory]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [anticipation, birthday]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 36424
    stratum: 'over_firer:tensions:aspiration_vs_acceptance'
    excerpt: "it makes me feel better but it's still wishy washy."
    question: "How does having a financial plan in place make you feel?"
    v7_current:
      joy_modes: [tranquil]
      tensions: [aspiration_vs_acceptance]
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: [tranquil]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [aspiration_vs_acceptance]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 40713
    stratum: 'over_firer:tensions:aspiration_vs_acceptance'
    excerpt: "I hope it will be better than last year"
    question: "How are you feeling about 2026 so far?"
    v7_current:
      joy_modes: []
      tensions: [aspiration_vs_acceptance]
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [aspiration_vs_acceptance]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 44719
    stratum: 'over_firer:tensions:aspiration_vs_acceptance'
    excerpt: "Relaxed. Focused. Mildly concerned about meeting those goals."
    question: "How does having a financial plan in place make you feel?"
    v7_current:
      joy_modes: [tranquil]
      tensions: [aspiration_vs_acceptance]
      functional_jobs: [plan_future, provide_security]
      occasions: []
    expected:
      joy_modes:
        must_include: [tranquil]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [aspiration_vs_acceptance]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [plan_future, provide_security]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 46211
    stratum: 'over_firer:tensions:aspiration_vs_acceptance'
    excerpt: "My boss kept saying he cannot pay us on time. We are all worried the company may closed. I am always proud of my job, wh"
    question: "What do you think has been making you feel less joyful than usual?"
    v7_current:
      joy_modes: [achievement]
      tensions: [aspiration_vs_acceptance]
      functional_jobs: [feel_proud]
      occasions: [work]
    expected:
      joy_modes:
        must_include: [achievement]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [aspiration_vs_acceptance]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [feel_proud]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [work]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 57367
    stratum: 'over_firer:tensions:aspiration_vs_acceptance'
    excerpt: "Im hoping to enjoy a life without roomates that are useless in 2026"
    question: "As we move toward the New Year, what are you hoping to enjoy in 2026?"
    v7_current:
      joy_modes: []
      tensions: [aspiration_vs_acceptance]
      functional_jobs: []
      occasions: [anticipation]
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [aspiration_vs_acceptance]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [anticipation]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 61455
    stratum: 'over_firer:tensions:aspiration_vs_acceptance'
    excerpt: "Glad I finally has a wood dining set instead of metal."
    question: "Thinking about a time when you bought something significant for your home that required saving up or planning carefully "
    v7_current:
      joy_modes: [aesthetic]
      tensions: [aspiration_vs_acceptance]
      functional_jobs: [reward_self]
      occasions: [post_purchase]
    expected:
      joy_modes:
        must_include: [aesthetic]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [aspiration_vs_acceptance]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [reward_self]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [post_purchase]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 198
    stratum: 'over_firer:occasions:anticipation'
    excerpt: "One of the things that has brought me joy is my morning cup of coffee. It's a simple pleasure, but it's something that I"
    question: "What are some things in your life ‚Äì products, services or experiences you have purchased ‚Äì that have brought you joy"
    v7_current:
      joy_modes: [hedonic, tranquil, inspirational, relational]
      tensions: [moderation_vs_indulgence]
      functional_jobs: [refuel, learn_grow, share_experience]
      occasions: [everyday, morning, anticipation, vacation]
    expected:
      joy_modes:
        must_include: [hedonic, tranquil, inspirational, relational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [moderation_vs_indulgence]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [refuel, learn_grow, share_experience]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [everyday, morning, anticipation, vacation]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 2247
    stratum: 'over_firer:occasions:anticipation'
    excerpt: "Having a wood burning stove and lots of wood on hand for the upcoming winter."
    question: "What else brings joy to your life?"
    v7_current:
      joy_modes: [tranquil]
      tensions: []
      functional_jobs: [provide_security]
      occasions: [anticipation]
    expected:
      joy_modes:
        must_include: [tranquil]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [provide_security]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [anticipation]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 3806
    stratum: 'over_firer:occasions:anticipation'
    excerpt: "I would expect to have a great time. I imagine I would go swimming with sharks and maybe do some snorkeling."
    question: "What kind of experience would you expect if you took a vacation to the Bahamas?"
    v7_current:
      joy_modes: [physical, hedonic]
      tensions: []
      functional_jobs: []
      occasions: [vacation, anticipation]
    expected:
      joy_modes:
        must_include: [physical, hedonic]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [vacation, anticipation]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 4905
    stratum: 'over_firer:occasions:anticipation'
    excerpt: "I want to experience another culture and cuisines"
    question: "What kind of experience would you expect if you took a vacation to Charleston, South Carolina?"
    v7_current:
      joy_modes: [inspirational]
      tensions: []
      functional_jobs: [learn_grow]
      occasions: [anticipation, vacation]
    expected:
      joy_modes:
        must_include: [inspirational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [learn_grow]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [anticipation, vacation]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 6678
    stratum: 'over_firer:occasions:anticipation'
    excerpt: "I recall seeing a hotels.com ad and it made me wanna go on vacation"
    question: "TOM_Ad"
    v7_current:
      joy_modes: [inspirational]
      tensions: []
      functional_jobs: []
      occasions: [anticipation]
    expected:
      joy_modes:
        must_include: [inspirational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [anticipation]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 8564
    stratum: 'over_firer:occasions:anticipation'
    excerpt: "Visiting the Kennedy Space Center Visitor Complex would likely provide a unique and educational experience centered arou"
    question: "What kind of experience would you expect if you visited Kennedy Space Center Visitor Complex?"
    v7_current:
      joy_modes: [awe, inspirational]
      tensions: []
      functional_jobs: [learn_grow, immerse_in_story]
      occasions: [anticipation, live_event]
    expected:
      joy_modes:
        must_include: [awe, inspirational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [learn_grow, immerse_in_story]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [anticipation, live_event]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 10062
    stratum: 'over_firer:occasions:anticipation'
    excerpt: "Get my mom and go on a cruise around the world"
    question: "What would you do if you won the lottery?"
    v7_current:
      joy_modes: [relational]
      tensions: []
      functional_jobs: [demonstrate_care, create_memory]
      occasions: [anticipation, vacation]
    expected:
      joy_modes:
        must_include: [relational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [demonstrate_care, create_memory]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [anticipation, vacation]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 10854
    stratum: 'over_firer:occasions:anticipation'
    excerpt: "A cruise to Alaska,   I have never been and I have read and heard so much about it that ie just made me want to go and s"
    question: "Let's talk about vacations! If you could travel anywhere in the world, what destination would bring you the most joy? Wh"
    v7_current:
      joy_modes: [inspirational, awe]
      tensions: []
      functional_jobs: [learn_grow]
      occasions: [vacation, anticipation]
    expected:
      joy_modes:
        must_include: [inspirational, awe]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [learn_grow]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [vacation, anticipation]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 11189
    stratum: 'over_firer:occasions:anticipation'
    excerpt: "A small island in Italy with nothing to do but eat good food and relax"
    question: "Let's talk about vacations! If you could travel anywhere in the world, what destination would bring you the most joy? Wh"
    v7_current:
      joy_modes: [hedonic, tranquil]
      tensions: []
      functional_jobs: [relax_recover]
      occasions: [vacation, anticipation]
    expected:
      joy_modes:
        must_include: [hedonic, tranquil]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [relax_recover]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [vacation, anticipation]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 11616
    stratum: 'over_firer:occasions:anticipation'
    excerpt: "Music, there is alot of music in the Smoky Mountains. I can see the evergreen trees in the distance with the fog over th"
    question: "What kind of experience would you expect if you took a vacation to the Smoky Mountains?"
    v7_current:
      joy_modes: [aesthetic, inspirational]
      tensions: []
      functional_jobs: []
      occasions: [anticipation, vacation]
    expected:
      joy_modes:
        must_include: [aesthetic, inspirational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [anticipation, vacation]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 11943
    stratum: 'over_firer:occasions:anticipation'
    excerpt: "To the beach with sand that is sugar white and clear ocean water"
    question: "Let's talk about vacations! If you could travel anywhere in the world, what destination would bring you the most joy? Wh"
    v7_current:
      joy_modes: [hedonic, aesthetic]
      tensions: []
      functional_jobs: []
      occasions: [vacation, anticipation]
    expected:
      joy_modes:
        must_include: [hedonic, aesthetic]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [vacation, anticipation]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 12371
    stratum: 'over_firer:occasions:anticipation'
    excerpt: "A great deal to see and do. New experiences and see moonshine mountain and go to Pigeon Forge##"
    question: "What kind of experience would you expect if you took a vacation to Gatlinburg, Tennessee?"
    v7_current:
      joy_modes: [inspirational]
      tensions: []
      functional_jobs: [learn_grow]
      occasions: [vacation, anticipation]
    expected:
      joy_modes:
        must_include: [inspirational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [learn_grow]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [vacation, anticipation]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 235
    stratum: 'over_firer:occasions:everyday'
    excerpt: "thing that bring me joy are gaming and playing with friends and family. i also like decorating my home for the fall seas"
    question: "What are some things in your life ‚Äì products, services or experiences you have purchased ‚Äì that have brought you joy"
    v7_current:
      joy_modes: [playful, relational, aesthetic, tranquil]
      tensions: []
      functional_jobs: [share_experience, express_creativity]
      occasions: [everyday]
    expected:
      joy_modes:
        must_include: [playful, relational, aesthetic, tranquil]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [share_experience, express_creativity]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [everyday]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 1316
    stratum: 'over_firer:occasions:everyday'
    excerpt: "Coffee, my kids, reading books, hanging out with my mom and dad"
    question: "What else brings joy to your life?"
    v7_current:
      joy_modes: [hedonic, relational]
      tensions: []
      functional_jobs: [build_belonging]
      occasions: [everyday]
    expected:
      joy_modes:
        must_include: [hedonic, relational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [build_belonging]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [everyday]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 2370
    stratum: 'over_firer:occasions:everyday'
    excerpt: "My pets help me so much to feel happy and peaceful. I love to read and to learn new things."
    question: "What else brings joy to your life?"
    v7_current:
      joy_modes: [relational, tranquil, hedonic, inspirational]
      tensions: []
      functional_jobs: [learn_grow, relax_recover]
      occasions: [everyday]
    expected:
      joy_modes:
        must_include: [relational, tranquil, hedonic, inspirational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [learn_grow, relax_recover]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [everyday]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 3324
    stratum: 'over_firer:occasions:everyday'
    excerpt: "Spending quality time with my dog and cat"
    question: "What else brings joy to your life?"
    v7_current:
      joy_modes: [relational]
      tensions: []
      functional_jobs: [build_belonging]
      occasions: [everyday]
    expected:
      joy_modes:
        must_include: [relational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [build_belonging]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [everyday]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 4484
    stratum: 'over_firer:occasions:everyday'
    excerpt: "I haven't bought many things that brought me joy,  enjoying a strong cup of coffee while listening to smooth jazz is an "
    question: "What are some things in your life ‚Äì products, services or experiences you have purchased ‚Äì that have brought you joy"
    v7_current:
      joy_modes: [hedonic, tranquil]
      tensions: []
      functional_jobs: [refuel]
      occasions: [everyday]
    expected:
      joy_modes:
        must_include: [hedonic, tranquil]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [refuel]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [everyday]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 7488
    stratum: 'over_firer:occasions:everyday'
    excerpt: "I go for long walks and listen to my music."
    question: "When you are stressed, what are some things you do - or buy - to bring joy back into your life? And why does that work f"
    v7_current:
      joy_modes: [physical, hedonic]
      tensions: []
      functional_jobs: [relax_recover]
      occasions: [everyday]
    expected:
      joy_modes:
        must_include: [physical, hedonic]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [relax_recover]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [everyday]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 8281
    stratum: 'over_firer:occasions:everyday'
    excerpt: "Excercise every single day to make sure that you are not getting sick"
    question: "When you are stressed, what are some things you do - or buy - to bring joy back into your life? And why does that work f"
    v7_current:
      joy_modes: [physical]
      tensions: []
      functional_jobs: [relax_recover]
      occasions: [everyday]
    expected:
      joy_modes:
        must_include: [physical]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [relax_recover]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [everyday]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 13876
    stratum: 'over_firer:occasions:everyday'
    excerpt: "play faster on games and get to where your going faster"
    question: "In what ways does having high-speed Internet at home bring you joy?"
    v7_current:
      joy_modes: [playful, physical]
      tensions: []
      functional_jobs: [refuel]
      occasions: [everyday]
    expected:
      joy_modes:
        must_include: [playful, physical]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [refuel]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [everyday]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 15564
    stratum: 'over_firer:occasions:everyday'
    excerpt: "Not having to wait for buffer for videos games or anything and seamless entertainment."
    question: "In what ways does having high-speed Internet at home bring you joy?"
    v7_current:
      joy_modes: [hedonic]
      tensions: []
      functional_jobs: [immerse_in_story]
      occasions: [everyday]
    expected:
      joy_modes:
        must_include: [hedonic]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [immerse_in_story]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [everyday]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 17034
    stratum: 'over_firer:occasions:everyday'
    excerpt: "Keep my life organized. Watch content to help unwind. Let's me research and solve problems"
    question: "What are some specific things that high-speed Internet enables you to do?"
    v7_current:
      joy_modes: [tranquil]
      tensions: []
      functional_jobs: [relax_recover, learn_grow, provide_security]
      occasions: [everyday]
    expected:
      joy_modes:
        must_include: [tranquil]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [relax_recover, learn_grow, provide_security]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [everyday]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 18537
    stratum: 'over_firer:occasions:everyday'
    excerpt: "Play games, stream videos and keep up with the news and do surveys."
    question: "What are some specific things that high-speed Internet enables you to do?"
    v7_current:
      joy_modes: [playful]
      tensions: []
      functional_jobs: [immerse_in_story]
      occasions: [everyday]
    expected:
      joy_modes:
        must_include: [playful]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [immerse_in_story]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [everyday]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 19439
    stratum: 'over_firer:occasions:everyday'
    excerpt: "WE GO THERE EVERY CCOUPLE OF YEARS. THERE IS SO MUCH TO SEE AND DO."
    question: "What kind of experience would you expect if you visited Kennedy Space Center Visitor Complex?"
    v7_current:
      joy_modes: [awe]
      tensions: []
      functional_jobs: [immerse_in_story]
      occasions: [vacation, everyday]
    expected:
      joy_modes:
        must_include: [awe]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [immerse_in_story]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [vacation, everyday]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 186
    stratum: 'over_firer:occasions:post_purchase'
    excerpt: "I had a new patio installed last year.  I love sitting outside and chilling."
    question: "What are some things in your life ‚Äì products, services or experiences you have purchased ‚Äì that have brought you joy"
    v7_current:
      joy_modes: [tranquil]
      tensions: []
      functional_jobs: [relax_recover]
      occasions: [post_purchase]
    expected:
      joy_modes:
        must_include: [tranquil]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [relax_recover]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [post_purchase]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 935
    stratum: 'over_firer:occasions:post_purchase'
    excerpt: "I recently got new fishing equipment, a new tent and a few camping accessories. I upgraded everything and have used all "
    question: "What are some things in your life ‚Äì products, services or experiences you have purchased ‚Äì that have brought you joy"
    v7_current:
      joy_modes: [freedom, tranquil]
      tensions: []
      functional_jobs: [relax_recover, escape_routine]
      occasions: [weekend, post_purchase]
    expected:
      joy_modes:
        must_include: [freedom, tranquil]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [relax_recover, escape_routine]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [weekend, post_purchase]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 1726
    stratum: 'over_firer:occasions:post_purchase'
    excerpt: "Purchasing my pet toys, food, and treats for my pets bring me much joy to see their faces and expressions when I bring h"
    question: "What are some things in your life ‚Äì products, services or experiences you have purchased ‚Äì that have brought you joy"
    v7_current:
      joy_modes: [relational]
      tensions: []
      functional_jobs: [demonstrate_care, nourish_others]
      occasions: [post_purchase]
    expected:
      joy_modes:
        must_include: [relational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [demonstrate_care, nourish_others]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [post_purchase]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 2514
    stratum: 'over_firer:occasions:post_purchase'
    excerpt: "The first car, house i bought with my own money. The fact that i bought those properties using my hard earned money make"
    question: "What are some things in your life ‚Äì products, services or experiences you have purchased ‚Äì that have brought you joy"
    v7_current:
      joy_modes: [achievement]
      tensions: []
      functional_jobs: [feel_proud]
      occasions: [post_purchase]
    expected:
      joy_modes:
        must_include: [achievement]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [feel_proud]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [post_purchase]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 3178
    stratum: 'over_firer:occasions:post_purchase'
    excerpt: "The main thing that brings me joy is my cat.  I adopted her 7 years ago.  She's my buddy and shadow.  She follows me fro"
    question: "What are some things in your life ‚Äì products, services or experiences you have purchased ‚Äì that have brought you joy"
    v7_current:
      joy_modes: [relational, sentimental]
      tensions: []
      functional_jobs: [build_belonging]
      occasions: [post_purchase]
    expected:
      joy_modes:
        must_include: [relational, sentimental]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [build_belonging]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [post_purchase]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 3923
    stratum: 'over_firer:occasions:post_purchase'
    excerpt: "New furniture because it was hard to get up from my old sofa and I had the same furniture for 25 years."
    question: "What are some things in your life ‚Äì products, services or experiences you have purchased ‚Äì that have brought you joy"
    v7_current:
      joy_modes: [achievement]
      tensions: [dwelling_vs_advancing]
      functional_jobs: [feel_proud]
      occasions: [post_purchase]
    expected:
      joy_modes:
        must_include: [achievement]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [dwelling_vs_advancing]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [feel_proud]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [post_purchase]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 4955
    stratum: 'over_firer:occasions:post_purchase'
    excerpt: "I bought a hat that I like very much. It looks great when I wear it while skiing, and it also attracts attention. I am v"
    question: "What are some things in your life ‚Äì products, services or experiences you have purchased ‚Äì that have brought you joy"
    v7_current:
      joy_modes: [aesthetic, physical]
      tensions: []
      functional_jobs: [signal_identity, reward_self]
      occasions: [post_purchase]
    expected:
      joy_modes:
        must_include: [aesthetic, physical]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [signal_identity, reward_self]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [post_purchase]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 8755
    stratum: 'over_firer:occasions:post_purchase'
    excerpt: "Hiking boots got a good deal and I needed them"
    question: "What's a recent example of a time you purchased something that brought you joy? What was it, from what brand or company "
    v7_current:
      joy_modes: []
      tensions: []
      functional_jobs: []
      occasions: [shopping, post_purchase]
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [shopping, post_purchase]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 9186
    stratum: 'over_firer:occasions:post_purchase'
    excerpt: "It was a board game that my wife & I love to play"
    question: "What's a recent example of a time you purchased something that brought you joy? What was it, from what brand or company "
    v7_current:
      joy_modes: [playful, relational]
      tensions: []
      functional_jobs: [share_experience]
      occasions: [post_purchase]
    expected:
      joy_modes:
        must_include: [playful, relational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [share_experience]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [post_purchase]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 9536
    stratum: 'over_firer:occasions:post_purchase'
    excerpt: "Several years ago when I purchased a new grass trimmer from Yard Machine at a bargain price and discovered why it was so"
    question: "What's an example of something you purchased that definitely did NOT bring you joy? What was it, from what brand or comp"
    v7_current:
      joy_modes: []
      tensions: [luxury_vs_value]
      functional_jobs: []
      occasions: [purchase_moment, post_purchase]
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [luxury_vs_value]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [purchase_moment, post_purchase]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 9858
    stratum: 'over_firer:occasions:post_purchase'
    excerpt: "I bought a new shirt that was really cute for my birthday. It brought me joy because it made me feel pretty while wearin"
    question: "What's a recent example of a time you purchased something that brought you joy? What was it, from what brand or company "
    v7_current:
      joy_modes: [hedonic, aesthetic]
      tensions: []
      functional_jobs: [reward_self]
      occasions: [birthday, post_purchase]
    expected:
      joy_modes:
        must_include: [hedonic, aesthetic]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [reward_self]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [birthday, post_purchase]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 10297
    stratum: 'over_firer:occasions:post_purchase'
    excerpt: "I had a new roof put on the house by Yoder Roofing Company and now my roof doesn't leak."
    question: "What's a recent example of a time you purchased something that brought you joy? What was it, from what brand or company "
    v7_current:
      joy_modes: [tranquil]
      tensions: []
      functional_jobs: [provide_security]
      occasions: [post_purchase]
    expected:
      joy_modes:
        must_include: [tranquil]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [provide_security]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [post_purchase]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 205
    stratum: 'fixed_win:joy_modes:achievement'
    excerpt: "purchased fishing tackle and caught a lot of fish"
    question: "What are some things in your life ‚Äì products, services or experiences you have purchased ‚Äì that have brought you joy"
    v7_current:
      joy_modes: [achievement, physical]
      tensions: []
      functional_jobs: [compete]
      occasions: [post_purchase]
    expected:
      joy_modes:
        must_include: [achievement, physical]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [compete]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [post_purchase]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 2948
    stratum: 'fixed_win:joy_modes:achievement'
    excerpt: "Getting married, having children. Seeing my children succeed"
    question: "What are some things in your life ‚Äì products, services or experiences you have purchased ‚Äì that have brought you joy"
    v7_current:
      joy_modes: [relational, achievement]
      tensions: []
      functional_jobs: [build_belonging, demonstrate_care]
      occasions: [celebration, memory]
    expected:
      joy_modes:
        must_include: [relational, achievement]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [build_belonging, demonstrate_care]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [celebration, memory]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 6613
    stratum: 'fixed_win:joy_modes:achievement'
    excerpt: "Feeling amazed and proud"
    question: "What kind of experience would you expect if you visited Kennedy Space Center Visitor Complex?"
    v7_current:
      joy_modes: [awe, achievement]
      tensions: []
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: [awe, achievement]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 9571
    stratum: 'fixed_win:joy_modes:achievement'
    excerpt: "I was excited about buying a riding lawn mower, it was a Troy Bilt pony, it makes lawn works so much easier"
    question: "What's a recent example of a time you purchased something that brought you joy? What was it, from what brand or company "
    v7_current:
      joy_modes: [achievement, physical]
      tensions: []
      functional_jobs: [reward_self]
      occasions: [purchase_moment, post_purchase]
    expected:
      joy_modes:
        must_include: [achievement, physical]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [reward_self]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [purchase_moment, post_purchase]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 12245
    stratum: 'fixed_win:joy_modes:achievement'
    excerpt: "A four pack of Heartland Express trailers made by Athearn to put on my flatcars, they look so good all together on the t"
    question: "What's a recent example of a time you purchased something that brought you joy? What was it, from what brand or company "
    v7_current:
      joy_modes: [aesthetic, achievement]
      tensions: []
      functional_jobs: [express_creativity, display_taste]
      occasions: [post_purchase]
    expected:
      joy_modes:
        must_include: [aesthetic, achievement]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [express_creativity, display_taste]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [post_purchase]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 19295
    stratum: 'fixed_win:joy_modes:achievement'
    excerpt: "Safe"
    question: "How does having a financial plan in place make you feel?"
    v7_current:
      joy_modes: [achievement]
      tensions: []
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: [achievement]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 24246
    stratum: 'fixed_win:joy_modes:achievement'
    excerpt: "Usaa"
    question: "How does having a financial plan in place make you feel?"
    v7_current:
      joy_modes: [achievement]
      tensions: []
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: [achievement]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 31823
    stratum: 'fixed_win:joy_modes:achievement'
    excerpt: "Lots of job success"
    question: "What do you think has been making you feel more joyful than usual?"
    v7_current:
      joy_modes: [achievement]
      tensions: []
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: [achievement]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 588
    stratum: 'fixed_win:tensions:served_vs_overlooked'
    excerpt: "I don't expect to be hated, but also to enjoy a lot of beautiful scenery"
    question: "What kind of experience would you expect if you took a vacation to Puerto Rico?"
    v7_current:
      joy_modes: [aesthetic, hedonic]
      tensions: [served_vs_overlooked]
      functional_jobs: []
      occasions: [vacation]
    expected:
      joy_modes:
        must_include: [aesthetic, hedonic]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [served_vs_overlooked]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [vacation]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 41741
    stratum: 'fixed_win:tensions:served_vs_overlooked'
    excerpt: "Sports are not important to me, education is. But women should be able to achieve the same as anyone else."
    question: "What do you hope happens to, or as a result of, women‚Äôs sports over the next 10 to 20 years?"
    v7_current:
      joy_modes: [achievement]
      tensions: [served_vs_overlooked]
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: [achievement]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [served_vs_overlooked]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 42051
    stratum: 'fixed_win:tensions:served_vs_overlooked'
    excerpt: "become as popular as mens sports"
    question: "What do you hope happens to, or as a result of, women‚Äôs sports over the next 10 to 20 years?"
    v7_current:
      joy_modes: []
      tensions: [served_vs_overlooked]
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [served_vs_overlooked]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 42380
    stratum: 'fixed_win:tensions:served_vs_overlooked'
    excerpt: "I hpe that it become as big and as important as men's sport"
    question: "What do you hope happens to, or as a result of, women‚Äôs sports over the next 10 to 20 years?"
    v7_current:
      joy_modes: []
      tensions: [served_vs_overlooked]
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [served_vs_overlooked]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 42764
    stratum: 'fixed_win:tensions:served_vs_overlooked'
    excerpt: "To expand and make more money may they all be successful and blessed."
    question: "What do you hope happens to, or as a result of, women‚Äôs sports over the next 10 to 20 years?"
    v7_current:
      joy_modes: []
      tensions: [served_vs_overlooked]
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [served_vs_overlooked]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 43155
    stratum: 'fixed_win:tensions:served_vs_overlooked'
    excerpt: "That they can play like men and be at the same level"
    question: "What do you hope happens to, or as a result of, women‚Äôs sports over the next 10 to 20 years?"
    v7_current:
      joy_modes: []
      tensions: [served_vs_overlooked]
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [served_vs_overlooked]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 43516
    stratum: 'fixed_win:tensions:served_vs_overlooked'
    excerpt: "I hope women's sports will be as popular as men's sports."
    question: "What do you hope happens to, or as a result of, women‚Äôs sports over the next 10 to 20 years?"
    v7_current:
      joy_modes: []
      tensions: [served_vs_overlooked]
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [served_vs_overlooked]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 57412
    stratum: 'fixed_win:tensions:served_vs_overlooked'
    excerpt: "Seeing them support getting justice and fighting for equal rights"
    question: "What's an example of a time when a brand got involved with something you are a fan of, and you really appreciated it? Pl"
    v7_current:
      joy_modes: [inspirational, self_actualization]
      tensions: [served_vs_overlooked]
      functional_jobs: [signal_identity]
      occasions: []
    expected:
      joy_modes:
        must_include: [inspirational, self_actualization]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [served_vs_overlooked]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [signal_identity]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 1646
    stratum: 'fixed_win:tensions:dwelling_vs_advancing'
    excerpt: "My children have brought me more joy than I thought possible. I miss them terribly."
    question: "What are some things in your life ‚Äì products, services or experiences you have purchased ‚Äì that have brought you joy"
    v7_current:
      joy_modes: [relational, sentimental]
      tensions: [dwelling_vs_advancing]
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: [relational, sentimental]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [dwelling_vs_advancing]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 10925
    stratum: 'fixed_win:tensions:dwelling_vs_advancing'
    excerpt: "Alaska, possibly cruise, whales. But also the forest, we have lost so much woods it saddens me."
    question: "Let's talk about vacations! If you could travel anywhere in the world, what destination would bring you the most joy? Wh"
    v7_current:
      joy_modes: [awe, tranquil]
      tensions: [dwelling_vs_advancing]
      functional_jobs: []
      occasions: [vacation, anticipation]
    expected:
      joy_modes:
        must_include: [awe, tranquil]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [dwelling_vs_advancing]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [vacation, anticipation]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 22611
    stratum: 'fixed_win:tensions:dwelling_vs_advancing'
    excerpt: "Good things happening in my daughter's life after a difficult divorce"
    question: "What do you think has been making you feel more joyful than usual?"
    v7_current:
      joy_modes: [relational, sentimental]
      tensions: [dwelling_vs_advancing]
      functional_jobs: [demonstrate_care]
      occasions: []
    expected:
      joy_modes:
        must_include: [relational, sentimental]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [dwelling_vs_advancing]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [demonstrate_care]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 29763
    stratum: 'fixed_win:tensions:dwelling_vs_advancing'
    excerpt: "Food is just average, noise level is high mostly because a surfaces are hard. Service is a bit slow. Decor is interestin"
    question: "How would you describe the experience of going to Cracker Barrel?"
    v7_current:
      joy_modes: [aesthetic]
      tensions: [dwelling_vs_advancing]
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: [aesthetic]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [dwelling_vs_advancing]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 37743
    stratum: 'fixed_win:tensions:dwelling_vs_advancing'
    excerpt: "I am a fan of volleyball. I used to play in high school and I loved it."
    question: "What or who are you a fan of, and why?"
    v7_current:
      joy_modes: [playful, sentimental]
      tensions: [dwelling_vs_advancing]
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: [playful, sentimental]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [dwelling_vs_advancing]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 45167
    stratum: 'fixed_win:tensions:dwelling_vs_advancing'
    excerpt: "It has to be better than last year"
    question: "How are you feeling about 2026 so far?"
    v7_current:
      joy_modes: []
      tensions: [dwelling_vs_advancing]
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [dwelling_vs_advancing]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 47383
    stratum: 'fixed_win:tensions:dwelling_vs_advancing'
    excerpt: "I used to live there. Not high on my visit list."
    question: "What kind of experience would you expect if you took a vacation to West Palm Beach, Florida?"
    v7_current:
      joy_modes: []
      tensions: [dwelling_vs_advancing]
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [dwelling_vs_advancing]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 58010
    stratum: 'fixed_win:tensions:dwelling_vs_advancing'
    excerpt: "if they decide to break the team up"
    question: "What would have to happen for (your #1) to lose you as a fan? ¬†"
    v7_current:
      joy_modes: []
      tensions: [dwelling_vs_advancing]
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [dwelling_vs_advancing]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 295
    stratum: 'fixed_win:functional_jobs:signal_identity'
    excerpt: "Lego brings me joy. I love my battle scene made from various marvel Lego sets"
    question: "What are some things in your life ‚Äì products, services or experiences you have purchased ‚Äì that have brought you joy"
    v7_current:
      joy_modes: [playful, aesthetic]
      tensions: []
      functional_jobs: [express_creativity, signal_identity]
      occasions: [post_purchase]
    expected:
      joy_modes:
        must_include: [playful, aesthetic]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [express_creativity, signal_identity]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [post_purchase]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 12827
    stratum: 'fixed_win:functional_jobs:signal_identity'
    excerpt: "I bought myself a stuffed animal. I realized I am old enough to make whatever decisions I want and can have a stuffed an"
    question: "What's a recent example of a time you purchased something that brought you joy? What was it, from what brand or company "
    v7_current:
      joy_modes: [achievement, freedom]
      tensions: []
      functional_jobs: [reward_self, signal_identity]
      occasions: [purchase_moment, post_purchase]
    expected:
      joy_modes:
        must_include: [achievement, freedom]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [reward_self, signal_identity]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [purchase_moment, post_purchase]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 34662
    stratum: 'fixed_win:functional_jobs:signal_identity'
    excerpt: "Sometime wear a hat or shirt to support my chosen teams."
    question: "How do you express your fandom? What are the things you do, say, wear..."
    v7_current:
      joy_modes: []
      tensions: []
      functional_jobs: [signal_identity]
      occasions: []
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [signal_identity]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 36034
    stratum: 'fixed_win:functional_jobs:signal_identity'
    excerpt: "I used to have a t-shirt with them on it. But I wore it out. I can rewatch the 3 seasons I have."
    question: "How do you express your fandom? What are the things you do, say, wear..."
    v7_current:
      joy_modes: []
      tensions: [dwelling_vs_advancing]
      functional_jobs: [signal_identity, immerse_in_story]
      occasions: []
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [dwelling_vs_advancing]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [signal_identity, immerse_in_story]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 37138
    stratum: 'fixed_win:functional_jobs:signal_identity'
    excerpt: "I wear OU stuff"
    question: "How do you express your fandom? What are the things you do, say, wear..."
    v7_current:
      joy_modes: []
      tensions: []
      functional_jobs: [signal_identity]
      occasions: []
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [signal_identity]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 38000
    stratum: 'fixed_win:functional_jobs:signal_identity'
    excerpt: "I talk about my fandoms a lot and would love to have more apparel celebrating them."
    question: "How do you express your fandom? What are the things you do, say, wear..."
    v7_current:
      joy_modes: [relational]
      tensions: [aspiration_vs_acceptance]
      functional_jobs: [signal_identity]
      occasions: [everyday]
    expected:
      joy_modes:
        must_include: [relational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [aspiration_vs_acceptance]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [signal_identity]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [everyday]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 39354
    stratum: 'fixed_win:functional_jobs:signal_identity'
    excerpt: "Kevin Gates the T-shirt I love his songs love the way he two and love his speeches just love everything about him"
    question: "What or who are you a fan of, and why?"
    v7_current:
      joy_modes: [hedonic, inspirational]
      tensions: []
      functional_jobs: [signal_identity, immerse_in_story]
      occasions: [post_purchase]
    expected:
      joy_modes:
        must_include: [hedonic, inspirational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [signal_identity, immerse_in_story]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [post_purchase]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 40838
    stratum: 'fixed_win:functional_jobs:signal_identity'
    excerpt: "I wear t-shirts showing that person, or place. A Willie Nelson shirt, 'have a Willie good day!'"
    question: "How do you express your fandom? What are the things you do, say, wear..."
    v7_current:
      joy_modes: []
      tensions: []
      functional_jobs: [signal_identity]
      occasions: []
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [signal_identity]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 1655
    stratum: 'untested:functional_jobs:compete'
    excerpt: "Being able to go to the casino to play poker"
    question: "What else brings joy to your life?"
    v7_current:
      joy_modes: [playful]
      tensions: []
      functional_jobs: [compete]
      occasions: []
    expected:
      joy_modes:
        must_include: [playful]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [compete]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 16219
    stratum: 'untested:functional_jobs:compete'
    excerpt: "to play games and do work"
    question: "What are some specific things that high-speed Internet enables you to do?"
    v7_current:
      joy_modes: []
      tensions: []
      functional_jobs: [compete]
      occasions: [work]
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [compete]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [work]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 25107
    stratum: 'untested:functional_jobs:compete'
    excerpt: "Not lag on games and also to be able to download games quickly"
    question: "What are some specific things that high-speed Internet enables you to do?"
    v7_current:
      joy_modes: [playful]
      tensions: []
      functional_jobs: [compete]
      occasions: []
    expected:
      joy_modes:
        must_include: [playful]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [compete]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 37711
    stratum: 'untested:functional_jobs:compete'
    excerpt: "Food, drinks, parties, music, time spent with friends, new relationships, learning new things, obtaining new levels of f"
    question: "As we move toward the New Year, what are you hoping to enjoy in 2025?"
    v7_current:
      joy_modes: [hedonic, relational, physical, inspirational]
      tensions: []
      functional_jobs: [share_experience, learn_grow, compete]
      occasions: [anticipation, celebration, gathering]
    expected:
      joy_modes:
        must_include: [hedonic, relational, physical, inspirational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [share_experience, learn_grow, compete]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [anticipation, celebration, gathering]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 53138
    stratum: 'untested:functional_jobs:compete'
    excerpt: "Discover new products and feel the joy of controlling your purchases."
    question: "What, if anything, makes grocery shopping joyful for you?"
    v7_current:
      joy_modes: [inspirational, achievement]
      tensions: [control_vs_surrender]
      functional_jobs: [compete]
      occasions: [shopping]
    expected:
      joy_modes:
        must_include: [inspirational, achievement]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [control_vs_surrender]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [compete]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [shopping]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 255
    stratum: 'untested:functional_jobs:connect_remotely'
    excerpt: "Cell phone, I am able to connect with friends and family while on the go doing other things at the same time. Pandora- I"
    question: "What are some things in your life ‚Äì products, services or experiences you have purchased ‚Äì that have brought you joy"
    v7_current:
      joy_modes: [relational, hedonic, physical]
      tensions: []
      functional_jobs: [connect_remotely, share_experience, relax_recover]
      occasions: [everyday]
    expected:
      joy_modes:
        must_include: [relational, hedonic, physical]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [connect_remotely, share_experience, relax_recover]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [everyday]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 15409
    stratum: 'untested:functional_jobs:connect_remotely'
    excerpt: "Because I can connect with my family"
    question: "In what ways does having high-speed Internet at home bring you joy?"
    v7_current:
      joy_modes: [relational]
      tensions: []
      functional_jobs: [connect_remotely]
      occasions: []
    expected:
      joy_modes:
        must_include: [relational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [connect_remotely]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 18187
    stratum: 'untested:functional_jobs:connect_remotely'
    excerpt: "I get to FaceTime my grandkids and kids"
    question: "In what ways does having high-speed Internet at home bring you joy?"
    v7_current:
      joy_modes: [relational]
      tensions: []
      functional_jobs: [connect_remotely, build_belonging]
      occasions: []
    expected:
      joy_modes:
        must_include: [relational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [connect_remotely, build_belonging]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 21107
    stratum: 'untested:functional_jobs:connect_remotely'
    excerpt: "I tend to see new products being advertised as well as getting connected to friends and famiy"
    question: "In what ways does having high-speed Internet at home bring you joy?"
    v7_current:
      joy_modes: []
      tensions: []
      functional_jobs: [connect_remotely]
      occasions: []
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [connect_remotely]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 24067
    stratum: 'untested:functional_jobs:connect_remotely'
    excerpt: "Great joy because I can't talk to my family faster"
    question: "In what ways does having high-speed Internet at home bring you joy?"
    v7_current:
      joy_modes: [relational]
      tensions: []
      functional_jobs: [connect_remotely]
      occasions: []
    expected:
      joy_modes:
        must_include: [relational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [connect_remotely]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 355
    stratum: 'untested:functional_jobs:display_taste'
    excerpt: "My 3rd car was a special car on so sporty and a lot of people turn their head to look at it which brings me joy"
    question: "What are some things in your life ‚Äì products, services or experiences you have purchased ‚Äì that have brought you joy"
    v7_current:
      joy_modes: [achievement, playful]
      tensions: []
      functional_jobs: [display_taste, feel_proud]
      occasions: [post_purchase]
    expected:
      joy_modes:
        must_include: [achievement, playful]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [display_taste, feel_proud]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [post_purchase]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 17577
    stratum: 'untested:functional_jobs:display_taste'
    excerpt: "Ellemax product xchair really stood out with executive sitting in his office with gigantic trading screens.  Very luxuri"
    question: "TOM_Ad"
    v7_current:
      joy_modes: [aesthetic, awe]
      tensions: []
      functional_jobs: [display_taste]
      occasions: []
    expected:
      joy_modes:
        must_include: [aesthetic, awe]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [display_taste]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 37038
    stratum: 'untested:functional_jobs:display_taste'
    excerpt: "Like to wear very stylish unique clothes"
    question: "How do you express your fandom? What are the things you do, say, wear..."
    v7_current:
      joy_modes: []
      tensions: []
      functional_jobs: [display_taste]
      occasions: []
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [display_taste]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 43126
    stratum: 'untested:functional_jobs:display_taste'
    excerpt: "If their values or aesthetic align with mine, I might be swayed to give them a try."
    question: "What motivates you to choose a challenger or underdog brand?"
    v7_current:
      joy_modes: [aesthetic]
      tensions: []
      functional_jobs: [display_taste]
      occasions: []
    expected:
      joy_modes:
        must_include: [aesthetic]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [display_taste]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 54735
    stratum: 'untested:functional_jobs:display_taste'
    excerpt: "Dressing up wearing make up Drawing Good food"
    question: "Over the past few weeks or months, what are some of the THINGS THAT HAVE BROUGHT JOY TO YOUR LIFE?"
    v7_current:
      joy_modes: [aesthetic, hedonic]
      tensions: []
      functional_jobs: [express_creativity, display_taste]
      occasions: []
    expected:
      joy_modes:
        must_include: [aesthetic, hedonic]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [express_creativity, display_taste]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 220
    stratum: 'untested:functional_jobs:express_creativity'
    excerpt: "New paints and art supplies always bring me joy, as painting is one of my favorite things to do."
    question: "What are some things in your life ‚Äì products, services or experiences you have purchased ‚Äì that have brought you joy"
    v7_current:
      joy_modes: [hedonic, self_actualization]
      tensions: []
      functional_jobs: [express_creativity, reward_self]
      occasions: [post_purchase]
    expected:
      joy_modes:
        must_include: [hedonic, self_actualization]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [express_creativity, reward_self]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [post_purchase]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 7730
    stratum: 'untested:functional_jobs:express_creativity'
    excerpt: "I've been spending a lot of time crocheting and knitting, which I find relaxing and satisfying."
    question: "What do you think has been making you feel more joyful than usual?"
    v7_current:
      joy_modes: [tranquil, achievement]
      tensions: []
      functional_jobs: [express_creativity, relax_recover]
      occasions: [everyday]
    expected:
      joy_modes:
        must_include: [tranquil, achievement]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [express_creativity, relax_recover]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [everyday]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 23581
    stratum: 'untested:functional_jobs:express_creativity'
    excerpt: "Upload photos to websites, download photos, create slideshows and movies and upload them to social media"
    question: "What are some specific things that high-speed Internet enables you to do?"
    v7_current:
      joy_modes: []
      tensions: []
      functional_jobs: [express_creativity, share_experience]
      occasions: []
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [express_creativity, share_experience]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 41403
    stratum: 'untested:functional_jobs:express_creativity'
    excerpt: "I don't really express it any type of way other than taking inspiration from it and you know doing my own thing with tha"
    question: "How do you express your fandom? What are the things you do, say, wear..."
    v7_current:
      joy_modes: [inspirational]
      tensions: []
      functional_jobs: [express_creativity]
      occasions: []
    expected:
      joy_modes:
        must_include: [inspirational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [express_creativity]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 52888
    stratum: 'untested:functional_jobs:express_creativity'
    excerpt: "grocery shopping is joyful when discovering new products tasting samples finding deals exploring fresh produce and plann"
    question: "What, if anything, makes grocery shopping joyful for you?"
    v7_current:
      joy_modes: [playful, hedonic, inspirational]
      tensions: [luxury_vs_value]
      functional_jobs: [express_creativity, plan_future]
      occasions: [shopping, everyday]
    expected:
      joy_modes:
        must_include: [playful, hedonic, inspirational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [luxury_vs_value]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [express_creativity, plan_future]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [shopping, everyday]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 688
    stratum: 'untested:functional_jobs:preserve_tradition'
    excerpt: "Going out with wife for a nice dinner and an entertainment event.  Getting together with family and grand kids, going to"
    question: "What are some things in your life ‚Äì products, services or experiences you have purchased ‚Äì that have brought you joy"
    v7_current:
      joy_modes: [relational, playful, hedonic]
      tensions: [luxury_vs_value]
      functional_jobs: [share_experience, demonstrate_care, build_belonging, immerse_in_story, preserve_tradition]
      occasions: [gathering, celebration, live_event, mealtime, holiday, special_occasion]
    expected:
      joy_modes:
        must_include: [relational, playful, hedonic]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [luxury_vs_value]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [share_experience, demonstrate_care, build_belonging, immerse_in_story, preserve_tradition]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [gathering, celebration, live_event, mealtime, holiday, special_occasion]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 28387
    stratum: 'untested:functional_jobs:preserve_tradition'
    excerpt: "Hallmark ornaments. I have bought some Christmas gifts for my grandchildren and children. They bring me joy because it's"
    question: "What are some brands, products, services or experiences you have purchased that have brought you joy? Please tell us abo"
    v7_current:
      joy_modes: [sentimental, relational]
      tensions: []
      functional_jobs: [create_memory, preserve_tradition, demonstrate_care]
      occasions: [holiday, gift_giving, post_purchase]
    expected:
      joy_modes:
        must_include: [sentimental, relational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [create_memory, preserve_tradition, demonstrate_care]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [holiday, gift_giving, post_purchase]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 46895
    stratum: 'untested:functional_jobs:preserve_tradition'
    excerpt: "Sticking to tradition"
    question: "Buying from a legacy brand feels like __________"
    v7_current:
      joy_modes: [tranquil]
      tensions: [challenger_vs_legacy, tradition_vs_modern]
      functional_jobs: [preserve_tradition]
      occasions: [purchase_moment]
    expected:
      joy_modes:
        must_include: [tranquil]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [challenger_vs_legacy, tradition_vs_modern]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [preserve_tradition]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [purchase_moment]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 50505
    stratum: 'untested:functional_jobs:preserve_tradition'
    excerpt: "Music during the holidays is joyful because it instantly taps into memories, emotions, and a sense of shared tradition. "
    question: "What is joyful about music during the holidays?"
    v7_current:
      joy_modes: [sentimental, relational, tranquil]
      tensions: [tradition_vs_modern]
      functional_jobs: [preserve_tradition]
      occasions: [holiday, memory]
    expected:
      joy_modes:
        must_include: [sentimental, relational, tranquil]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [tradition_vs_modern]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [preserve_tradition]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [holiday, memory]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 52973
    stratum: 'untested:functional_jobs:preserve_tradition'
    excerpt: "Holiday music is very joyful. It shows that it's a Christmas holiday makes everything feel very Christmassy when it's in"
    question: "What is joyful about music during the holidays?"
    v7_current:
      joy_modes: [sentimental, relational]
      tensions: []
      functional_jobs: [preserve_tradition]
      occasions: [holiday]
    expected:
      joy_modes:
        must_include: [sentimental, relational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [preserve_tradition]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [holiday]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 254
    stratum: 'untested:joy_modes:self_actualization'
    excerpt: "Spending time with my kids and grandkids, going out with friends, singing, reading books, helping someone in need, readi"
    question: "What else brings joy to your life?"
    v7_current:
      joy_modes: [relational, playful, self_actualization, spiritual]
      tensions: []
      functional_jobs: [build_belonging, demonstrate_care, share_experience]
      occasions: [gathering, everyday]
    expected:
      joy_modes:
        must_include: [relational, playful, self_actualization, spiritual]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [build_belonging, demonstrate_care, share_experience]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [gathering, everyday]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 12450
    stratum: 'untested:joy_modes:self_actualization'
    excerpt: "I understand life on a more deep and closer level"
    question: "What do you think has been making you feel more joyful than usual?"
    v7_current:
      joy_modes: [self_actualization]
      tensions: []
      functional_jobs: [learn_grow]
      occasions: []
    expected:
      joy_modes:
        must_include: [self_actualization]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [learn_grow]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 37598
    stratum: 'untested:joy_modes:self_actualization'
    excerpt: "Cooking because it's a way to express my confidently"
    question: "What or who are you a fan of, and why?"
    v7_current:
      joy_modes: [self_actualization]
      tensions: []
      functional_jobs: [express_creativity]
      occasions: []
    expected:
      joy_modes:
        must_include: [self_actualization]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [express_creativity]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 48101
    stratum: 'untested:joy_modes:self_actualization'
    excerpt: "Things that have brought me joy has been just enjoying my own company. When you truly love yourself, it makes quite the "
    question: "Over the past few weeks or months, what are some of the THINGS THAT HAVE BROUGHT JOY TO YOUR LIFE?"
    v7_current:
      joy_modes: [tranquil, self_actualization]
      tensions: []
      functional_jobs: [relax_recover]
      occasions: [alone_time, everyday]
    expected:
      joy_modes:
        must_include: [tranquil, self_actualization]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [relax_recover]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [alone_time, everyday]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 58705
    stratum: 'untested:joy_modes:self_actualization'
    excerpt: "I got to come up with my own characters and spend quality time woth my sister"
    question: "Think about one specific moment related to (your #1) that made you feel incredibly happy, excited, or moved. What happen"
    v7_current:
      joy_modes: [playful, relational, self_actualization]
      tensions: []
      functional_jobs: [express_creativity, demonstrate_care]
      occasions: [gathering]
    expected:
      joy_modes:
        must_include: [playful, relational, self_actualization]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [express_creativity, demonstrate_care]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [gathering]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 185
    stratum: 'untested:joy_modes:spiritual'
    excerpt: "my God and my family"
    question: "What else brings joy to your life?"
    v7_current:
      joy_modes: [spiritual, relational]
      tensions: []
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: [spiritual, relational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 10811
    stratum: 'untested:joy_modes:spiritual'
    excerpt: "Israel. I want to walk were Jesus walked."
    question: "Let's talk about vacations! If you could travel anywhere in the world, what destination would bring you the most joy? Wh"
    v7_current:
      joy_modes: [spiritual, inspirational]
      tensions: []
      functional_jobs: [create_memory]
      occasions: [anticipation, vacation]
    expected:
      joy_modes:
        must_include: [spiritual, inspirational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [create_memory]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [anticipation, vacation]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 28715
    stratum: 'untested:joy_modes:spiritual'
    excerpt: "Read my Bible & pray as this gives me hope & comfort. Praise God for the many beautiful things in the world & the peace "
    question: "When you are stressed, what are some things you do - or buy - to bring joy back into your life? And why does that work f"
    v7_current:
      joy_modes: [spiritual, tranquil, sentimental]
      tensions: []
      functional_jobs: [relieve_anxiety, relax_recover]
      occasions: []
    expected:
      joy_modes:
        must_include: [spiritual, tranquil, sentimental]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [relieve_anxiety, relax_recover]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 40226
    stratum: 'untested:joy_modes:spiritual'
    excerpt: "I'm a fan of God because he knows what is best for you."
    question: "What or who are you a fan of, and why?"
    v7_current:
      joy_modes: [spiritual]
      tensions: []
      functional_jobs: [provide_security]
      occasions: []
    expected:
      joy_modes:
        must_include: [spiritual]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [provide_security]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 48456
    stratum: 'untested:joy_modes:spiritual'
    excerpt: "I'm happy when I see someone drawing close to,Jehovah God"
    question: "How would you describe WHAT IT FEELS LIKE when you EXPERIENCE JOY?"
    v7_current:
      joy_modes: [spiritual, relational]
      tensions: []
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: [spiritual, relational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 454
    stratum: 'untested:joy_modes:triumph'
    excerpt: "The fact that I have been blessed to see my son and daughter grow. I was told that I have about 6 months to live when I "
    question: "What else brings joy to your life?"
    v7_current:
      joy_modes: [sentimental, spiritual, relational, triumph]
      tensions: []
      functional_jobs: [create_memory, demonstrate_care]
      occasions: [memory, celebration]
    expected:
      joy_modes:
        must_include: [sentimental, spiritual, relational, triumph]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [create_memory, demonstrate_care]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [memory, celebration]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 44590
    stratum: 'untested:joy_modes:triumph'
    excerpt: "Finding a great deal on a brand I love feels like hitting the jackpot! It's that perfect mix of excitement and satisfact"
    question: "What does it feel like when you find a great deal on a brand you love?"
    v7_current:
      joy_modes: [triumph, hedonic, awe]
      tensions: [luxury_vs_value]
      functional_jobs: [reward_self]
      occasions: [shopping, purchase_moment]
    expected:
      joy_modes:
        must_include: [triumph, hedonic, awe]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [luxury_vs_value]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [reward_self]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [shopping, purchase_moment]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 56098
    stratum: 'untested:joy_modes:triumph'
    excerpt: "Anytime the American gymnasts do well in competitions."
    question: "Think about one specific moment related to (your #1) that made you feel incredibly happy, excited, or moved. What happen"
    v7_current:
      joy_modes: [triumph, relational]
      tensions: [individual_vs_communal]
      functional_jobs: [cheer_team]
      occasions: [live_event, sports_viewing]
    expected:
      joy_modes:
        must_include: [triumph, relational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [individual_vs_communal]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [cheer_team]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [live_event, sports_viewing]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 57109
    stratum: 'untested:joy_modes:triumph'
    excerpt: "With Steph Curry won the championship"
    question: "Think about one specific moment related to (your #1) that made you feel incredibly happy, excited, or moved. What happen"
    v7_current:
      joy_modes: [triumph]
      tensions: []
      functional_jobs: [cheer_team]
      occasions: [sports_viewing]
    expected:
      joy_modes:
        must_include: [triumph]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [cheer_team]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [sports_viewing]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 58480
    stratum: 'untested:joy_modes:triumph'
    excerpt: "last minute scoring that won the game really uplifted me"
    question: "Think about one specific moment related to (your #1) that made you feel incredibly happy, excited, or moved. What happen"
    v7_current:
      joy_modes: [triumph, playful]
      tensions: []
      functional_jobs: [cheer_team]
      occasions: [sports_viewing, in_moment]
    expected:
      joy_modes:
        must_include: [triumph, playful]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [cheer_team]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [sports_viewing, in_moment]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 314
    stratum: 'untested:occasions:alone_time'
    excerpt: "Watching TV with my dogs Reading a good book Listening to Gospel music"
    question: "What else brings joy to your life?"
    v7_current:
      joy_modes: [playful, relational, tranquil, spiritual]
      tensions: []
      functional_jobs: [relax_recover, immerse_in_story]
      occasions: [everyday, alone_time]
    expected:
      joy_modes:
        must_include: [playful, relational, tranquil, spiritual]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [relax_recover, immerse_in_story]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [everyday, alone_time]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 8556
    stratum: 'untested:occasions:alone_time'
    excerpt: "I like to watch classic movies.  They bring me back to a time where I was less stressed."
    question: "When you are stressed, what are some things you do - or buy - to bring joy back into your life? And why does that work f"
    v7_current:
      joy_modes: [sentimental]
      tensions: []
      functional_jobs: [immerse_in_story]
      occasions: [alone_time]
    expected:
      joy_modes:
        must_include: [sentimental]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [immerse_in_story]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [alone_time]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 28698
    stratum: 'untested:occasions:alone_time'
    excerpt: "Can soak and relax for however long I want"
    question: "What is joyful about taking a bath?"
    v7_current:
      joy_modes: [tranquil, freedom]
      tensions: []
      functional_jobs: [relax_recover]
      occasions: [alone_time]
    expected:
      joy_modes:
        must_include: [tranquil, freedom]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [relax_recover]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [alone_time]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 31479
    stratum: 'untested:occasions:alone_time'
    excerpt: "I view Dr Teal's as a widely perceived as a soothing and affordable wellness brand that focuses on relaxation and self-c"
    question: "What is your perception of Dr Teals?"
    v7_current:
      joy_modes: [tranquil, hedonic]
      tensions: [luxury_vs_value]
      functional_jobs: [relax_recover, reward_self]
      occasions: [alone_time]
    expected:
      joy_modes:
        must_include: [tranquil, hedonic]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [luxury_vs_value]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [relax_recover, reward_self]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [alone_time]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 33911
    stratum: 'untested:occasions:alone_time'
    excerpt: "Having time to myself to do nothing"
    question: "What is joyful about taking a bath?"
    v7_current:
      joy_modes: [tranquil]
      tensions: []
      functional_jobs: [relax_recover]
      occasions: [alone_time]
    expected:
      joy_modes:
        must_include: [tranquil]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [relax_recover]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [alone_time]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 267
    stratum: 'untested:occasions:birthday'
    excerpt: "nice restaurant for bday dinner. Made me feel really special and happy"
    question: "What are some things in your life ‚Äì products, services or experiences you have purchased ‚Äì that have brought you joy"
    v7_current:
      joy_modes: [hedonic, relational]
      tensions: []
      functional_jobs: [demonstrate_care, mark_milestone]
      occasions: [birthday, mealtime, celebration]
    expected:
      joy_modes:
        must_include: [hedonic, relational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [demonstrate_care, mark_milestone]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [birthday, mealtime, celebration]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 9562
    stratum: 'untested:occasions:birthday'
    excerpt: "I bought steaks to grill on my birthday.  It is one of my favorite foods."
    question: "What's a recent example of a time you purchased something that brought you joy? What was it, from what brand or company "
    v7_current:
      joy_modes: [hedonic]
      tensions: []
      functional_jobs: [reward_self]
      occasions: [birthday, post_purchase]
    expected:
      joy_modes:
        must_include: [hedonic]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [reward_self]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [birthday, post_purchase]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 18506
    stratum: 'untested:occasions:birthday'
    excerpt: "Spending time with family on my birthday"
    question: "What are some brands, products, services or experiences you have purchased that have brought you joy? Please tell us abo"
    v7_current:
      joy_modes: [relational]
      tensions: []
      functional_jobs: [build_belonging]
      occasions: [birthday, gathering]
    expected:
      joy_modes:
        must_include: [relational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [build_belonging]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [birthday, gathering]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 30746
    stratum: 'untested:occasions:birthday'
    excerpt: "Getting a massage monthly and tattoo for my birthday"
    question: "What are some brands, products, services or experiences you have purchased that have brought you joy? Please tell us abo"
    v7_current:
      joy_modes: [tranquil, relational]
      tensions: []
      functional_jobs: [relax_recover, mark_milestone]
      occasions: [birthday, post_purchase]
    expected:
      joy_modes:
        must_include: [tranquil, relational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [relax_recover, mark_milestone]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [birthday, post_purchase]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 47450
    stratum: 'untested:occasions:birthday'
    excerpt: "Being able to plan a very special birthday celebration"
    question: "Over the past few weeks or months, what are some of the THINGS THAT HAVE BROUGHT JOY TO YOUR LIFE?"
    v7_current:
      joy_modes: []
      tensions: []
      functional_jobs: [mark_milestone]
      occasions: [anticipation, birthday]
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [mark_milestone]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [anticipation, birthday]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 315
    stratum: 'untested:occasions:evening'
    excerpt: "My Keurig coffee maker brings me joy because I love coffee, and it makes it so easy and convenient to make a cup of coff"
    question: "What are some things in your life ‚Äì products, services or experiences you have purchased ‚Äì that have brought you joy"
    v7_current:
      joy_modes: [hedonic, tranquil]
      tensions: []
      functional_jobs: [refuel, relax_recover]
      occasions: [everyday, evening]
    expected:
      joy_modes:
        must_include: [hedonic, tranquil]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [refuel, relax_recover]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [everyday, evening]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 22372
    stratum: 'untested:occasions:evening'
    excerpt: "Shea moisture lotion sooths me at the end of the day. Peet's coffee or Celsius get me going before work. Dansko shoes ke"
    question: "What are some brands, products, services or experiences you have purchased that have brought you joy? Please tell us abo"
    v7_current:
      joy_modes: [tranquil, physical, hedonic]
      tensions: []
      functional_jobs: [refuel, relax_recover]
      occasions: [evening, morning, work]
    expected:
      joy_modes:
        must_include: [tranquil, physical, hedonic]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [refuel, relax_recover]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [evening, morning, work]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 29695
    stratum: 'untested:occasions:evening'
    excerpt: "It's relaxing after a hard day"
    question: "What is joyful about taking a bath?"
    v7_current:
      joy_modes: [tranquil]
      tensions: []
      functional_jobs: [relax_recover]
      occasions: [evening]
    expected:
      joy_modes:
        must_include: [tranquil]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [relax_recover]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [evening]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 31493
    stratum: 'untested:occasions:evening'
    excerpt: "i take long hot showers when i get home from work"
    question: "What is joyful about taking a bath?"
    v7_current:
      joy_modes: [tranquil, physical]
      tensions: []
      functional_jobs: [relax_recover]
      occasions: [evening]
    expected:
      joy_modes:
        must_include: [tranquil, physical]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [relax_recover]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [evening]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 34055
    stratum: 'untested:occasions:evening'
    excerpt: "An uninterrupted, quite night out by the water with my wife."
    question: "When you think about joy, what comes to mind for you?"
    v7_current:
      joy_modes: [tranquil, relational]
      tensions: []
      functional_jobs: [share_experience]
      occasions: [evening]
    expected:
      joy_modes:
        must_include: [tranquil, relational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [share_experience]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [evening]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 274
    stratum: 'untested:occasions:holiday'
    excerpt: "Trip to Brazil and Foz de Iguazu, New Years trip and the weather was gorgeous and the water falls were spectacular."
    question: "What are some things in your life ‚Äì products, services or experiences you have purchased ‚Äì that have brought you joy"
    v7_current:
      joy_modes: [awe, aesthetic]
      tensions: []
      functional_jobs: [create_memory]
      occasions: [vacation, holiday, in_moment]
    expected:
      joy_modes:
        must_include: [awe, aesthetic]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [create_memory]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [vacation, holiday, in_moment]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 32881
    stratum: 'untested:occasions:holiday'
    excerpt: "Having my wife coming down from heaven to join us today for Thanksgiving."
    question: "When you think about joy, what comes to mind for you?"
    v7_current:
      joy_modes: [relational, sentimental]
      tensions: []
      functional_jobs: [create_memory]
      occasions: [holiday, gathering]
    expected:
      joy_modes:
        must_include: [relational, sentimental]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [create_memory]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [holiday, gathering]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 50380
    stratum: 'untested:occasions:holiday'
    excerpt: "Just the sounds of the music for the holidays it's a Joyce full time thinking of good things trimming the tree and buyin"
    question: "What is joyful about music during the holidays?"
    v7_current:
      joy_modes: [hedonic, relational, sentimental]
      tensions: []
      functional_jobs: [share_experience, create_memory]
      occasions: [holiday, gathering]
    expected:
      joy_modes:
        must_include: [hedonic, relational, sentimental]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [share_experience, create_memory]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [holiday, gathering]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 51049
    stratum: 'untested:occasions:holiday'
    excerpt: "a brain came together and you remember good and bad times"
    question: "What is joyful about music during the holidays?"
    v7_current:
      joy_modes: [sentimental, relational]
      tensions: []
      functional_jobs: [create_memory]
      occasions: [holiday, memory]
    expected:
      joy_modes:
        must_include: [sentimental, relational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [create_memory]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [holiday, memory]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 51863
    stratum: 'untested:occasions:holiday'
    excerpt: "Pleasant when hearing in moderation. Being bombarded by holiday music gets to be nerve wracking."
    question: "What is joyful about music during the holidays?"
    v7_current:
      joy_modes: [hedonic]
      tensions: [moderation_vs_indulgence]
      functional_jobs: []
      occasions: [holiday]
    expected:
      joy_modes:
        must_include: [hedonic]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [moderation_vs_indulgence]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [holiday]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 4228
    stratum: 'untested:occasions:hosting'
    excerpt: "Made me joyful to host Christmas Dinner here recently.  My son was here and made braciole from scratch and it was delici"
    question: "What are some things in your life ‚Äì products, services or experiences you have purchased ‚Äì that have brought you joy"
    v7_current:
      joy_modes: [relational, sentimental, hedonic, self_actualization]
      tensions: [self_vs_others]
      functional_jobs: [nourish_others, demonstrate_care, preserve_tradition, create_memory, learn_grow]
      occasions: [hosting, mealtime, celebration, memory]
    expected:
      joy_modes:
        must_include: [relational, sentimental, hedonic, self_actualization]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [self_vs_others]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [nourish_others, demonstrate_care, preserve_tradition, create_memory, learn_grow]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [hosting, mealtime, celebration, memory]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 34894
    stratum: 'untested:occasions:hosting'
    excerpt: "I thriwna super bowl party at my house pizza"
    question: "How do you celebrate/watch/enjoy the Superbowl? What are some of your big game traditions?"
    v7_current:
      joy_modes: [relational, hedonic]
      tensions: []
      functional_jobs: [share_experience, nourish_others]
      occasions: [hosting, gathering, live_event]
    expected:
      joy_modes:
        must_include: [relational, hedonic]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [share_experience, nourish_others]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [hosting, gathering, live_event]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 36297
    stratum: 'untested:occasions:hosting'
    excerpt: "Love having friends over and making nachos and buffalo dip"
    question: "How do you celebrate/watch/enjoy the Superbowl? What are some of your big game traditions?"
    v7_current:
      joy_modes: [relational, hedonic]
      tensions: []
      functional_jobs: [share_experience, nourish_others]
      occasions: [gathering, hosting]
    expected:
      joy_modes:
        must_include: [relational, hedonic]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [share_experience, nourish_others]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [gathering, hosting]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 38361
    stratum: 'untested:occasions:hosting'
    excerpt: "I'm going to cook some chicken wings on my grill for me and my family and friends at my house"
    question: "How do you celebrate/watch/enjoy the Superbowl? What are some of your big game traditions?"
    v7_current:
      joy_modes: [relational]
      tensions: []
      functional_jobs: [nourish_others, share_experience]
      occasions: [hosting, gathering]
    expected:
      joy_modes:
        must_include: [relational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [nourish_others, share_experience]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [hosting, gathering]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 40482
    stratum: 'untested:occasions:hosting'
    excerpt: "I usually watch with friends at my house or there's and we make food"
    question: "How do you celebrate/watch/enjoy the Superbowl? What are some of your big game traditions?"
    v7_current:
      joy_modes: [relational, hedonic]
      tensions: []
      functional_jobs: [share_experience, nourish_others]
      occasions: [live_event, gathering, hosting, mealtime]
    expected:
      joy_modes:
        must_include: [relational, hedonic]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [share_experience, nourish_others]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [live_event, gathering, hosting, mealtime]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 234
    stratum: 'untested:occasions:morning'
    excerpt: "working out and keeping fit, allows me to start the say right and feel energized."
    question: "What else brings joy to your life?"
    v7_current:
      joy_modes: [physical, inspirational]
      tensions: []
      functional_jobs: [refuel]
      occasions: [morning]
    expected:
      joy_modes:
        must_include: [physical, inspirational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [refuel]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [morning]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 6648
    stratum: 'untested:occasions:morning'
    excerpt: "Give me extra level strength to start my days"
    question: "What comes to mind when you think of taking a VITAMIN or SUPPLEMENT?"
    v7_current:
      joy_modes: [physical]
      tensions: []
      functional_jobs: [refuel]
      occasions: [morning]
    expected:
      joy_modes:
        must_include: [physical]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [refuel]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [morning]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 26631
    stratum: 'untested:occasions:morning'
    excerpt: "That it comes in the morning (from) the bible"
    question: "When you think about joy, what comes to mind for you?"
    v7_current:
      joy_modes: [spiritual]
      tensions: []
      functional_jobs: []
      occasions: [morning]
    expected:
      joy_modes:
        must_include: [spiritual]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [morning]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 45255
    stratum: 'untested:occasions:morning'
    excerpt: "Opening my eyes every  morning tells me it's a good day!"
    question: "Over the past few weeks or months, what are some of the THINGS THAT HAVE BROUGHT JOY TO YOUR LIFE?"
    v7_current:
      joy_modes: [inspirational]
      tensions: []
      functional_jobs: []
      occasions: [morning]
    expected:
      joy_modes:
        must_include: [inspirational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [morning]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 48812
    stratum: 'untested:occasions:morning'
    excerpt: "waking up in the morning.  my kids."
    question: "Over the past few weeks or months, what are some of the THINGS THAT HAVE BROUGHT JOY TO YOUR LIFE?"
    v7_current:
      joy_modes: [relational]
      tensions: []
      functional_jobs: []
      occasions: [morning]
    expected:
      joy_modes:
        must_include: [relational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [morning]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 455
    stratum: 'untested:occasions:service'
    excerpt: "Having my hair colored , cut and styled at the Cancer Institute I go to. They love to pamper you. They also do massages."
    question: "What are some things in your life ‚Äì products, services or experiences you have purchased ‚Äì that have brought you joy"
    v7_current:
      joy_modes: [hedonic, tranquil, relational]
      tensions: []
      functional_jobs: [relax_recover, escape_routine]
      occasions: [service]
    expected:
      joy_modes:
        must_include: [hedonic, tranquil, relational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [relax_recover, escape_routine]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [service]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 43352
    stratum: 'untested:occasions:service'
    excerpt: "I looked for a planner/advisor who had expertise in the areas I needed help with, such as budgeting, investing, and reti"
    question: "How did you identify and select the planner/advisor you decided to work with?"
    v7_current:
      joy_modes: []
      tensions: []
      functional_jobs: [learn_grow, plan_future]
      occasions: [service]
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [learn_grow, plan_future]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [service]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 61703
    stratum: 'untested:occasions:service'
    excerpt: "The person was very helpful and helped me to select good things that were on sale at the time and if they had it in the "
    question: "What made that experience stand out? What were you shopping for and how did the employee impact your experience?"
    v7_current:
      joy_modes: []
      tensions: []
      functional_jobs: []
      occasions: [shopping, service]
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [shopping, service]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 62114
    stratum: 'untested:occasions:service'
    excerpt: "the employee was very nice and asked me if I needed anything"
    question: "What made that experience stand out? What were you shopping for and how did the employee impact your experience?"
    v7_current:
      joy_modes: [relational]
      tensions: []
      functional_jobs: [demonstrate_care]
      occasions: [service]
    expected:
      joy_modes:
        must_include: [relational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [demonstrate_care]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [service]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 62582
    stratum: 'untested:occasions:service'
    excerpt: "I was shopping for a coach. The employee really helped me with selecting all the options, he then gave me all the prices"
    question: "What made that experience stand out? What were you shopping for and how did the employee impact your experience?"
    v7_current:
      joy_modes: []
      tensions: []
      functional_jobs: [learn_grow]
      occasions: [shopping, service]
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [learn_grow]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [shopping, service]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 2258
    stratum: 'untested:occasions:transition'
    excerpt: "Our dog,he's always happy to greet me when I come home from work"
    question: "What are some things in your life ‚Äì products, services or experiences you have purchased ‚Äì that have brought you joy"
    v7_current:
      joy_modes: [relational]
      tensions: []
      functional_jobs: [build_belonging]
      occasions: [transition]
    expected:
      joy_modes:
        must_include: [relational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [build_belonging]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [transition]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 25549
    stratum: 'untested:occasions:transition'
    excerpt: "Getting to layer up to stay warm"
    question: "As Summer turns to Fall, what are some of the things that bring you joy? How and/or why do they bring you joy?"
    v7_current:
      joy_modes: [physical]
      tensions: []
      functional_jobs: []
      occasions: [transition]
    expected:
      joy_modes:
        must_include: [physical]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [transition]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 26719
    stratum: 'untested:occasions:transition'
    excerpt: "See the leaves change colors and feeling the brisk in the air."
    question: "As Summer turns to Fall, what are some of the things that bring you joy? How and/or why do they bring you joy?"
    v7_current:
      joy_modes: [aesthetic, physical]
      tensions: []
      functional_jobs: []
      occasions: [transition]
    expected:
      joy_modes:
        must_include: [aesthetic, physical]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [transition]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 27109
    stratum: 'untested:occasions:transition'
    excerpt: "The cold weather brings me joy. Something about it just makes me feel so sentimental. I think it might be because I have"
    question: "As Summer turns to Fall, what are some of the things that bring you joy? How and/or why do they bring you joy?"
    v7_current:
      joy_modes: [sentimental, tranquil]
      tensions: []
      functional_jobs: []
      occasions: [transition]
    expected:
      joy_modes:
        must_include: [sentimental, tranquil]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [transition]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 32703
    stratum: 'untested:occasions:transition'
    excerpt: "Moving my wife and I to be with a large part of our family."
    question: "What do you think has been making you feel more joyful than usual?"
    v7_current:
      joy_modes: [relational]
      tensions: []
      functional_jobs: [build_belonging]
      occasions: [transition]
    expected:
      joy_modes:
        must_include: [relational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [build_belonging]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [transition]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 1055
    stratum: 'untested:occasions:travel_journey'
    excerpt: "My honda pilot has taken me to the most joyous places one being to go see my children that live 9 hours away. It has tak"
    question: "What are some things in your life ‚Äì products, services or experiences you have purchased ‚Äì that have brought you joy"
    v7_current:
      joy_modes: [relational, sentimental]
      tensions: []
      functional_jobs: [build_belonging, create_memory]
      occasions: [vacation, travel_journey]
    expected:
      joy_modes:
        must_include: [relational, sentimental]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [build_belonging, create_memory]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [vacation, travel_journey]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 12394
    stratum: 'untested:occasions:travel_journey'
    excerpt: "I think some of it would be commercialized but that would be okay as a site seer.  The fun of it would be getting there "
    question: "What kind of experience would you expect if you took a vacation to Pigeon Forge, Tennessee?"
    v7_current:
      joy_modes: [aesthetic, playful]
      tensions: []
      functional_jobs: []
      occasions: [vacation, travel_journey]
    expected:
      joy_modes:
        must_include: [aesthetic, playful]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [vacation, travel_journey]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 27692
    stratum: 'untested:occasions:travel_journey'
    excerpt: "Enjoying my wife's company while travelling to be with our children"
    question: "When you think about joy, what comes to mind for you?"
    v7_current:
      joy_modes: [relational]
      tensions: []
      functional_jobs: [share_experience]
      occasions: [travel_journey, gathering]
    expected:
      joy_modes:
        must_include: [relational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [share_experience]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [travel_journey, gathering]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 34338
    stratum: 'untested:occasions:travel_journey'
    excerpt: "My children and going on trips to see my long distance boyfriend."
    question: "When you think about joy, what comes to mind for you?"
    v7_current:
      joy_modes: [relational]
      tensions: []
      functional_jobs: [connect_remotely]
      occasions: [travel_journey]
    expected:
      joy_modes:
        must_include: [relational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [connect_remotely]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [travel_journey]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 48749
    stratum: 'untested:occasions:travel_journey'
    excerpt: "Going to visit family and friends"
    question: "What road trips - short or long - have you taken (or are you planning) this summer and fall?"
    v7_current:
      joy_modes: [relational]
      tensions: []
      functional_jobs: [build_belonging]
      occasions: [travel_journey]
    expected:
      joy_modes:
        must_include: [relational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [build_belonging]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [travel_journey]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 2756
    stratum: 'untested:occasions:weekend'
    excerpt: "I'm very boring now that I'm older, it's all about the food now, what brings me joy is a good piece of cheesecake! Or re"
    question: "What are some things in your life ‚Äì products, services or experiences you have purchased ‚Äì that have brought you joy"
    v7_current:
      joy_modes: [hedonic, tranquil]
      tensions: []
      functional_jobs: [refuel, relax_recover]
      occasions: [weekend, everyday]
    expected:
      joy_modes:
        must_include: [hedonic, tranquil]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [refuel, relax_recover]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [weekend, everyday]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 18868
    stratum: 'untested:occasions:weekend'
    excerpt: "Auto zone get in the zone big sales and big sales for my auto needs is awesome right now so got my attention to get to m"
    question: "TOM_Ad"
    v7_current:
      joy_modes: []
      tensions: []
      functional_jobs: []
      occasions: [shopping, weekend]
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [shopping, weekend]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 27758
    stratum: 'untested:occasions:weekend'
    excerpt: "A weekend with my kids and husband"
    question: "When you think about joy, what comes to mind for you?"
    v7_current:
      joy_modes: [relational]
      tensions: []
      functional_jobs: [build_belonging]
      occasions: [weekend]
    expected:
      joy_modes:
        must_include: [relational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [build_belonging]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [weekend]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 45400
    stratum: 'untested:occasions:weekend'
    excerpt: "Over the past few weeks, a few little things have brought me a lot of joy. I discovered a cozy little coffee shop tucked"
    question: "Over the past few weeks or months, what are some of the THINGS THAT HAVE BROUGHT JOY TO YOUR LIFE?"
    v7_current:
      joy_modes: [tranquil, aesthetic, playful, relational, self_actualization]
      tensions: []
      functional_jobs: [relax_recover, express_creativity, nourish_others]
      occasions: [everyday, weekend, alone_time]
    expected:
      joy_modes:
        must_include: [tranquil, aesthetic, playful, relational, self_actualization]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [relax_recover, express_creativity, nourish_others]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [everyday, weekend, alone_time]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 49496
    stratum: 'untested:occasions:weekend'
    excerpt: "Usually a less hectic occasion, especially weekends, pastries or other treats accompany"
    question: "What joys or pleasures do you get from drinking coffee with loved ones or friends?"
    v7_current:
      joy_modes: [relational, tranquil, hedonic]
      tensions: []
      functional_jobs: [share_experience, relax_recover]
      occasions: [weekend, gathering]
    expected:
      joy_modes:
        must_include: [relational, tranquil, hedonic]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [share_experience, relax_recover]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [weekend, gathering]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 1009
    stratum: 'untested:tensions:digital_vs_physical'
    excerpt: "Camping because I love sitting time with my family disconnected"
    question: "What are some things in your life ‚Äì products, services or experiences you have purchased ‚Äì that have brought you joy"
    v7_current:
      joy_modes: [relational, tranquil]
      tensions: [digital_vs_physical]
      functional_jobs: [build_belonging]
      occasions: [vacation]
    expected:
      joy_modes:
        must_include: [relational, tranquil]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [digital_vs_physical]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [build_belonging]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [vacation]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 12036
    stratum: 'untested:tensions:digital_vs_physical'
    excerpt: "Spending time with my son making cupcakes together. No phones or screens, just us hanging out."
    question: "What's a recent example of a time you purchased something that brought you joy? What was it, from what brand or company "
    v7_current:
      joy_modes: [relational, playful]
      tensions: [digital_vs_physical]
      functional_jobs: [share_experience, build_belonging]
      occasions: [everyday]
    expected:
      joy_modes:
        must_include: [relational, playful]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [digital_vs_physical]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [share_experience, build_belonging]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [everyday]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 29005
    stratum: 'untested:tensions:digital_vs_physical'
    excerpt: "Family turns off there phones and are sitting around the dinner table learning to talk to each other!"
    question: "TOM_Ad"
    v7_current:
      joy_modes: [relational]
      tensions: [digital_vs_physical]
      functional_jobs: [build_belonging]
      occasions: [mealtime, gathering]
    expected:
      joy_modes:
        must_include: [relational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [digital_vs_physical]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [build_belonging]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [mealtime, gathering]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 42884
    stratum: 'untested:tensions:digital_vs_physical'
    excerpt: "One ad that stands out is Apple's recent iPad commercial, where they used a dramatic visual of a hydraulic press crushin"
    question: "TOM_Ad"
    v7_current:
      joy_modes: [aesthetic, awe]
      tensions: [digital_vs_physical]
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: [aesthetic, awe]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [digital_vs_physical]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 55241
    stratum: 'untested:tensions:digital_vs_physical'
    excerpt: "My sense of nostalgia has boosted my mood. I recently bought an mp3 player so I can own my music and listen to it withou"
    question: "Over the past few weeks or months, what are some of the THINGS THAT HAVE BROUGHT JOY TO YOUR LIFE?"
    v7_current:
      joy_modes: [sentimental, hedonic, freedom]
      tensions: [digital_vs_physical]
      functional_jobs: [reward_self]
      occasions: [post_purchase]
    expected:
      joy_modes:
        must_include: [sentimental, hedonic, freedom]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [digital_vs_physical]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [reward_self]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [post_purchase]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 1361
    stratum: 'untested:tensions:individual_vs_communal'
    excerpt: "Food, podcasts, I would say friends but in reality it's friend."
    question: "What else brings joy to your life?"
    v7_current:
      joy_modes: [hedonic, relational]
      tensions: [individual_vs_communal]
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: [hedonic, relational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [individual_vs_communal]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 28505
    stratum: 'untested:tensions:individual_vs_communal'
    excerpt: "The things I do bring me joy, like gardening, playing with my cats, talking to and visiting with my family, reading a bo"
    question: "When you are stressed, what are some things you do - or buy - to bring joy back into your life? And why does that work f"
    v7_current:
      joy_modes: [physical, relational, playful, tranquil, self_actualization]
      tensions: [individual_vs_communal]
      functional_jobs: [relax_recover, build_belonging]
      occasions: [everyday, alone_time]
    expected:
      joy_modes:
        must_include: [physical, relational, playful, tranquil, self_actualization]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [individual_vs_communal]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [relax_recover, build_belonging]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [everyday, alone_time]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 35093
    stratum: 'untested:tensions:individual_vs_communal'
    excerpt: "I am green bay packer fan because they are from the same state I live in and the first NFL team that is fan owned"
    question: "What or who are you a fan of, and why?"
    v7_current:
      joy_modes: [relational]
      tensions: [individual_vs_communal]
      functional_jobs: [cheer_team, signal_identity]
      occasions: [sports_viewing]
    expected:
      joy_modes:
        must_include: [relational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [individual_vs_communal]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [cheer_team, signal_identity]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [sports_viewing]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 48821
    stratum: 'untested:tensions:individual_vs_communal'
    excerpt: "My children, time alone, Mother's Day out."
    question: "Over the past few weeks or months, what are some of the THINGS THAT HAVE BROUGHT JOY TO YOUR LIFE?"
    v7_current:
      joy_modes: [relational]
      tensions: [individual_vs_communal]
      functional_jobs: [build_belonging]
      occasions: [alone_time, celebration]
    expected:
      joy_modes:
        must_include: [relational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [individual_vs_communal]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [build_belonging]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [alone_time, celebration]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 58556
    stratum: 'untested:tensions:individual_vs_communal'
    excerpt: "I think when Brands support our troops and especially honor those who have served or currently serving. It helps us to c"
    question: "What's an example of a time when a brand got involved with something you are a fan of, and you really appreciated it? Pl"
    v7_current:
      joy_modes: [relational, spiritual]
      tensions: [individual_vs_communal]
      functional_jobs: [build_belonging, demonstrate_care]
      occasions: [celebration]
    expected:
      joy_modes:
        must_include: [relational, spiritual]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [individual_vs_communal]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [build_belonging, demonstrate_care]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [celebration]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 1470
    stratum: 'untested:tensions:introvert_vs_extrovert'
    excerpt: "I like being alone with a good book on a rainy day."
    question: "What else brings joy to your life?"
    v7_current:
      joy_modes: [tranquil, hedonic]
      tensions: [introvert_vs_extrovert]
      functional_jobs: [relax_recover]
      occasions: [alone_time]
    expected:
      joy_modes:
        must_include: [tranquil, hedonic]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [introvert_vs_extrovert]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [relax_recover]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [alone_time]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 15141
    stratum: 'untested:tensions:introvert_vs_extrovert'
    excerpt: "any not in or near a big major city as I prefer less crowded and small town locations"
    question: "If you could vacation at ANY FLORIDA DESTINATION, which one would you choose? Why?"
    v7_current:
      joy_modes: []
      tensions: [introvert_vs_extrovert]
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [introvert_vs_extrovert]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 24551
    stratum: 'untested:tensions:introvert_vs_extrovert'
    excerpt: "Popular spots for watching football games include sports bars for their lively atmosphere and large screens, or home set"
    question: "What are some of your favorite places to watch football games?"
    v7_current:
      joy_modes: [playful, relational]
      tensions: [introvert_vs_extrovert]
      functional_jobs: [cheer_team]
      occasions: [sports_viewing, live_event]
    expected:
      joy_modes:
        must_include: [playful, relational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [introvert_vs_extrovert]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [cheer_team]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [sports_viewing, live_event]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 30072
    stratum: 'untested:tensions:introvert_vs_extrovert'
    excerpt: "I don't really like eating at restaurants, honestly. I feel like I'm being judged if I'm out in a restaurant, especially"
    question: "When you go out for a restaurant meal, what types of experiences are you looking for?"
    v7_current:
      joy_modes: [freedom]
      tensions: [introvert_vs_extrovert, luxury_vs_value]
      functional_jobs: [relax_recover]
      occasions: [everyday]
    expected:
      joy_modes:
        must_include: [freedom]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [introvert_vs_extrovert, luxury_vs_value]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [relax_recover]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [everyday]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 35518
    stratum: 'untested:tensions:introvert_vs_extrovert'
    excerpt: "I don't know much about Phoenix.  I know Arizona is warm and I would enjoy that aspect of it.  Phoenix is a big city and"
    question: "What kind of experience would you expect if you took a vacation to Phoenix, or the greater Phoenix area?"
    v7_current:
      joy_modes: [tranquil]
      tensions: [introvert_vs_extrovert]
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: [tranquil]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [introvert_vs_extrovert]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 435
    stratum: 'untested:tensions:moderation_vs_indulgence'
    excerpt: "I bought some chocolate that is good for you, but tastes wonderful.  It brought me joy."
    question: "What are some things in your life ‚Äì products, services or experiences you have purchased ‚Äì that have brought you joy"
    v7_current:
      joy_modes: [hedonic]
      tensions: [moderation_vs_indulgence]
      functional_jobs: [reward_self]
      occasions: [purchase_moment]
    expected:
      joy_modes:
        must_include: [hedonic]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [moderation_vs_indulgence]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [reward_self]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [purchase_moment]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 10574
    stratum: 'untested:tensions:moderation_vs_indulgence'
    excerpt: "I purchased a Boston cream donut from dunkin donuts it brought me joy because it was a sweet indulgent from my regular r"
    question: "What's a recent example of a time you purchased something that brought you joy? What was it, from what brand or company "
    v7_current:
      joy_modes: [hedonic]
      tensions: [moderation_vs_indulgence]
      functional_jobs: [reward_self]
      occasions: [purchase_moment, post_purchase]
    expected:
      joy_modes:
        must_include: [hedonic]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [moderation_vs_indulgence]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [reward_self]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [purchase_moment, post_purchase]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 31133
    stratum: 'untested:tensions:moderation_vs_indulgence'
    excerpt: "going to spa/salon because it is indulgent self-care"
    question: "When you are stressed, what are some things you do - or buy - to bring joy back into your life? And why does that work f"
    v7_current:
      joy_modes: [hedonic, tranquil]
      tensions: [moderation_vs_indulgence]
      functional_jobs: [relax_recover, reward_self]
      occasions: []
    expected:
      joy_modes:
        must_include: [hedonic, tranquil]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [moderation_vs_indulgence]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [relax_recover, reward_self]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 50649
    stratum: 'untested:tensions:moderation_vs_indulgence'
    excerpt: "The smooth, creamy chocolate instantly evokes childhood nostalgia, brightens my day with its familiar taste, & offers a "
    question: "What is joyful about a Hershey bar?"
    v7_current:
      joy_modes: [hedonic, sentimental, relational]
      tensions: [individual_vs_communal, moderation_vs_indulgence]
      functional_jobs: [reward_self, share_experience]
      occasions: [everyday, post_purchase]
    expected:
      joy_modes:
        must_include: [hedonic, sentimental, relational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [individual_vs_communal, moderation_vs_indulgence]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [reward_self, share_experience]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [everyday, post_purchase]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 60912
    stratum: 'untested:tensions:moderation_vs_indulgence'
    excerpt: "Healthy eating is joyful because it gives you energy and makes you feel good in your body, turning meals into a source o"
    question: "What is joyful about healthy eating?"
    v7_current:
      joy_modes: [hedonic, physical, inspirational]
      tensions: [moderation_vs_indulgence]
      functional_jobs: [refuel, learn_grow]
      occasions: [mealtime]
    expected:
      joy_modes:
        must_include: [hedonic, physical, inspirational]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [moderation_vs_indulgence]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [refuel, learn_grow]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [mealtime]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 1486
    stratum: 'untested:tensions:performance_vs_pleasure'
    excerpt: "Eating great food such as lobster or other seafood. One, I know seafood is good for me and is healthy and two, I love ho"
    question: "What else brings joy to your life?"
    v7_current:
      joy_modes: [hedonic]
      tensions: [performance_vs_pleasure]
      functional_jobs: [refuel]
      occasions: [mealtime]
    expected:
      joy_modes:
        must_include: [hedonic]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [performance_vs_pleasure]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [refuel]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [mealtime]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 26716
    stratum: 'untested:tensions:performance_vs_pleasure'
    excerpt: "There's a lot of advertisements on different medications. It will state that it works on certain things but it also stat"
    question: "TOM_Ad"
    v7_current:
      joy_modes: []
      tensions: [performance_vs_pleasure]
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [performance_vs_pleasure]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 29699
    stratum: 'untested:tensions:performance_vs_pleasure'
    excerpt: "Eating at home doesn't cause stomach issues, eating out does"
    question: "What are the pros and cons of going out to a restaurant vs. eating at home?"
    v7_current:
      joy_modes: []
      tensions: [performance_vs_pleasure]
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [performance_vs_pleasure]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 31416
    stratum: 'untested:tensions:performance_vs_pleasure'
    excerpt: "Not having to cook Unhealthy"
    question: "What are the pros and cons of going out to a restaurant vs. eating at home?"
    v7_current:
      joy_modes: []
      tensions: [performance_vs_pleasure]
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [performance_vs_pleasure]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 59727
    stratum: 'untested:tensions:performance_vs_pleasure'
    excerpt: "When politicians talk in ways that makes it clear that they're trying to get attention, a sound byte rather than make an"
    question: "In your own words: When does politics feel most like entertainment/spectacle to you? What makes it feel that way?"
    v7_current:
      joy_modes: []
      tensions: [performance_vs_pleasure]
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [performance_vs_pleasure]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 4835
    stratum: 'untested:tensions:tradition_vs_modern'
    excerpt: "I would expect it to be somewhat of a slow time and behind the times city. But also a lot of history to be seen and take"
    question: "What kind of experience would you expect if you took a vacation to Winston-Salem, North Carolina?"
    v7_current:
      joy_modes: [awe]
      tensions: [tradition_vs_modern]
      functional_jobs: [learn_grow]
      occasions: []
    expected:
      joy_modes:
        must_include: [awe]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [tradition_vs_modern]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [learn_grow]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 23192
    stratum: 'untested:tensions:tradition_vs_modern'
    excerpt: "I like having information available when I seek for it, but speed isn't the most important facet, as I came from a file-"
    question: "In what ways does having high-speed Internet at home bring you joy?"
    v7_current:
      joy_modes: []
      tensions: [tradition_vs_modern]
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [tradition_vs_modern]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 31482
    stratum: 'untested:tensions:tradition_vs_modern'
    excerpt: "Traveling to Japan would bring me the most joy because of its blend of tradition and modernity, from ancient temples and"
    question: "Let's talk about vacations! If you could travel anywhere in the world, what destination would bring you the most joy? Wh"
    v7_current:
      joy_modes: [awe, aesthetic]
      tensions: [tradition_vs_modern]
      functional_jobs: [plan_future]
      occasions: [anticipation, vacation]
    expected:
      joy_modes:
        must_include: [awe, aesthetic]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [tradition_vs_modern]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [plan_future]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [anticipation, vacation]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 40145
    stratum: 'untested:tensions:tradition_vs_modern'
    excerpt: "A rustic fun and old school experience with jousting and knights and horses"
    question: "What kind of experience would you expect if you visited Medieval Times Dinner and Tournament?"
    v7_current:
      joy_modes: [playful, aesthetic]
      tensions: [tradition_vs_modern]
      functional_jobs: [immerse_in_story]
      occasions: []
    expected:
      joy_modes:
        must_include: [playful, aesthetic]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [tradition_vs_modern]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [immerse_in_story]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 50973
    stratum: 'untested:tensions:tradition_vs_modern'
    excerpt: "Ah... happy reminders of my youth.  I know many do not like holiday music, but I cherish it.  Except for a couple of hel"
    question: "What is joyful about music during the holidays?"
    v7_current:
      joy_modes: [sentimental]
      tensions: [tradition_vs_modern]
      functional_jobs: []
      occasions: [holiday]
    expected:
      joy_modes:
        must_include: [sentimental]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: [tradition_vs_modern]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: [holiday]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 5002
    stratum: 'thin_control'
    excerpt: "If it's Winston-Salem University's annual Homecoming event, then football and concerts."
    question: "What kind of experience would you expect if you took a vacation to Winston-Salem, North Carolina?"
    v7_current:
      joy_modes: []
      tensions: []
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 5028
    stratum: 'thin_control'
    excerpt: "The liberty mutual ad with two women and a baby,  and the baby's first word was 'liberty'"
    question: "TOM_Ad"
    v7_current:
      joy_modes: []
      tensions: []
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 5060
    stratum: 'thin_control'
    excerpt: "it would be interesting"
    question: "What kind of experience would you expect if you visited Kennedy Space Center Visitor Complex?"
    v7_current:
      joy_modes: []
      tensions: []
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 5084
    stratum: 'thin_control'
    excerpt: "Colonial history"
    question: "What kind of experience would you expect if you took a vacation to Winston-Salem, North Carolina?"
    v7_current:
      joy_modes: []
      tensions: []
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 5111
    stratum: 'thin_control'
    excerpt: "local history and mild weather"
    question: "What kind of experience would you expect if you took a vacation to Asheville, North Carolina?"
    v7_current:
      joy_modes: []
      tensions: []
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 5139
    stratum: 'thin_control'
    excerpt: "Wireless services"
    question: "TOM_Ad"
    v7_current:
      joy_modes: []
      tensions: []
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 5163
    stratum: 'thin_control'
    excerpt: "A really enjoyable experience"
    question: "What kind of experience would you expect if you took a vacation to Asheville, North Carolina?"
    v7_current:
      joy_modes: []
      tensions: []
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 5185
    stratum: 'thin_control'
    excerpt: "SleepyJoe and team woke seem to be losing over and over but unfortunately their incompetence continues to be legendary"
    question: "What do you think has been making you feel more joyful than usual?"
    v7_current:
      joy_modes: []
      tensions: []
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 5204
    stratum: 'thin_control'
    excerpt: "My car."
    question: "What are some things in your life ‚Äì products, services or experiences you have purchased ‚Äì that have brought you joy"
    v7_current:
      joy_modes: []
      tensions: []
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 5230
    stratum: 'thin_control'
    excerpt: "Nothing in particular"
    question: "TOM_Ad"
    v7_current:
      joy_modes: []
      tensions: []
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 5254
    stratum: 'thin_control'
    excerpt: "Cheetos"
    question: "TOM_Ad"
    v7_current:
      joy_modes: []
      tensions: []
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 5276
    stratum: 'thin_control'
    excerpt: "Watching different cultures"
    question: "What kind of experience would you expect if you took a vacation to Wisconsin?"
    v7_current:
      joy_modes: []
      tensions: []
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 5294
    stratum: 'thin_control'
    excerpt: "Just an okay experience"
    question: "What kind of experience would you expect if you took a vacation to Virginia Beach, Virginia?"
    v7_current:
      joy_modes: []
      tensions: []
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 5317
    stratum: 'thin_control'
    excerpt: "To stay healthy"
    question: "What comes to mind when you think of taking a VITAMIN or SUPPLEMENT?"
    v7_current:
      joy_modes: []
      tensions: []
      functional_jobs: [provide_security]
      occasions: []
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [provide_security]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 5336
    stratum: 'thin_control'
    excerpt: "Always wonder if it's doing any good"
    question: "What comes to mind when you think of taking a VITAMIN or SUPPLEMENT?"
    v7_current:
      joy_modes: []
      tensions: []
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 5356
    stratum: 'thin_control'
    excerpt: "I can't think of any."
    question: "TOM_Ad"
    v7_current:
      joy_modes: []
      tensions: []
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 5385
    stratum: 'thin_control'
    excerpt: "I just woke my ringer on vibrate so"
    question: "What kind of experience would you expect if you took a vacation to Ocean City, Maryland?"
    v7_current:
      joy_modes: []
      tensions: []
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 5413
    stratum: 'thin_control'
    excerpt: "a happy experience"
    question: "What kind of experience would you expect if you took a vacation to Wisconsin?"
    v7_current:
      joy_modes: []
      tensions: []
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 5440
    stratum: 'thin_control'
    excerpt: "Learning a lot"
    question: "What kind of experience would you expect if you visited Kennedy Space Center Visitor Complex?"
    v7_current:
      joy_modes: []
      tensions: []
      functional_jobs: [learn_grow]
      occasions: []
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: [learn_grow]    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

  - id: 5456
    stratum: 'thin_control'
    excerpt: "Inflation"
    question: "What do you think has been making you feel less joyful than usual?"
    v7_current:
      joy_modes: []
      tensions: []
      functional_jobs: []
      occasions: []
    expected:
      joy_modes:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      tensions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      functional_jobs:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim
      occasions:
        must_include: []    # remove tags that don't fit; add tags v7 missed
        may_include: []             # tags that are defensible but not required
        must_not_include: []        # tags v7 should never apply to this verbatim

```

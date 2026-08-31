/*
 * The Slop Mixed Bag — eighteen rounds, a hundred and eighty questions,
 * written for a room with an eleven-year-old and a sixty-year-old in it at the
 * same time.
 *
 * Most questions draw on 2000 onwards. Where one reaches back it goes a long
 * way back, to before anyone in the room was born, rather than sitting in the
 * decades that reward being the oldest person at the table.
 *
 * Each round was drafted and fact-checked separately, then assembled here; the
 * URL on every question is the source its answer was checked against, and the
 * app shows it on the reveal. No answer repeats anywhere in the pack.
 *
 * Two music rounds stream real records from Apple's preview service — nothing is
 * downloaded or re-hosted, only the track id and preview URL are stored. The
 * Backwards Music round marks its clips with reverse: true, which makes the app
 * decode the preview and play it back to front.
 *
 * The format is documented in SCHEMA.md.
 */

export default {
    "id": "slop-mixed-02",
    "name": "The Slop Mixed Bag",
    "description": "Eighteen rounds written for a mixed-age room, so a child and a grandparent both get a fair crack: dogs, films of the 2020s, Formula One, Disney, cocktails, anatomy, logos, modern cars, emoji equations and more, plus two music rounds that stream the real records — one played forwards, one played backwards, and a round aimed squarely at the youngest player.",
    "author": "slop.zackpollard.pro",
    "createdOn": "2026-08-30",
    "version": 2,
    "tags": [
        "pub",
        "family",
        "mixed-age",
        "modern"
    ],
    "rounds": [
        {
            "id": "dog-breeds",
            "name": "Best in Show",
            "icon": "🐕",
            "intro": "Ten questions on dogs — the ones you'd meet on a walk, the ones on the telly, and one or two you'd be very lucky ever to see. Lead on, and no barking at the host.",
            "questions": [
                {
                    "question": "In the children's cartoon Bluey, what breed of dog is Bluey herself?",
                    "answer": "Blue Heeler",
                    "acceptable": [
                        "Australian Cattle Dog",
                        "Heeler",
                        "Cattle dog",
                        "Blue Heeler (Australian Cattle Dog)"
                    ],
                    "difficulty": "easy",
                    "topic": "Dogs on television",
                    "funFact": "Bluey's mum Chilli is a Red Heeler — exactly the same breed, just a different coat colour.",
                    "source": {
                        "name": "Wikipedia — Bluey (2018 TV series)",
                        "url": "https://en.wikipedia.org/wiki/Bluey_(2018_TV_series)"
                    }
                },
                {
                    "question": "In Paw Patrol, Marshall is the team's fire pup. What breed of dog is he?",
                    "answer": "Dalmatian",
                    "acceptable": [
                        "Dalmation",
                        "Dalmatian dog",
                        "Spotty dog"
                    ],
                    "difficulty": "easy",
                    "topic": "Dogs on television",
                    "funFact": "Real Dalmatians ran alongside horse-drawn fire engines, which is how they became firehouse mascots.",
                    "source": {
                        "name": "Wikipedia — List of PAW Patrol characters",
                        "url": "https://en.wikipedia.org/wiki/List_of_PAW_Patrol_characters"
                    }
                },
                {
                    "question": "The cockapoo has become one of Britain's most popular crossbreeds. Which two breeds are crossed to make one?",
                    "answer": "Cocker Spaniel and Poodle",
                    "acceptable": [
                        "Poodle and Cocker Spaniel",
                        "Cocker and Poodle",
                        "Spaniel and Poodle",
                        "English Cocker Spaniel and Poodle",
                        "Cocker Spaniel crossed with a Poodle"
                    ],
                    "difficulty": "easy",
                    "topic": "Crossbreeds",
                    "funFact": "Purina says the poodle parent is usually a toy or miniature, which keeps the cockapoo small.",
                    "source": {
                        "name": "Purina UK — Cockapoo breed guide",
                        "url": "https://www.purina.co.uk/find-a-pet/dog-breeds/cockapoo"
                    }
                },
                {
                    "question": "Queen Elizabeth II was famously devoted to corgis, and still had two — Muick and Sandy — when she died in 2022. There are two corgi breeds: which one were hers, Pembroke or Cardigan?",
                    "answer": "Pembroke Welsh Corgi",
                    "acceptable": [
                        "Pembroke",
                        "Pembroke Corgi",
                        "Welsh Corgi (Pembroke)",
                        "Pembroke Welsh"
                    ],
                    "difficulty": "medium",
                    "topic": "Famous dogs",
                    "funFact": "Elizabeth II owned more than 30 corgis between her accession in 1952 and her death in 2022.",
                    "source": {
                        "name": "Wikipedia — Royal corgis",
                        "url": "https://en.wikipedia.org/wiki/Royal_corgis"
                    }
                },
                {
                    "question": "The name of which short-legged breed, seen on pavements all over Britain today, translates from German as 'badger dog'?",
                    "answer": "Dachshund",
                    "acceptable": [
                        "Sausage dog",
                        "Daschund",
                        "Doxie",
                        "Wiener dog",
                        "Teckel"
                    ],
                    "difficulty": "medium",
                    "topic": "Breed origins",
                    "funFact": "The long body and short legs were the whole point — they were built to go down badger setts.",
                    "source": {
                        "name": "American Kennel Club — Dachshund History: The Badger Dog's Fascinating Past",
                        "url": "https://www.akc.org/expert-advice/dog-breeds/dachshund-history-badger-dog-breed/"
                    }
                },
                {
                    "question": "Guide Dogs UK says that over 60% of its working guide dogs are a cross between which two retriever breeds?",
                    "answer": "Labrador Retriever and Golden Retriever",
                    "acceptable": [
                        "Labrador and Golden Retriever",
                        "Lab and Golden",
                        "Golden Retriever and Labrador",
                        "Labrador crossed with Golden Retriever",
                        "Labrador and Golden"
                    ],
                    "difficulty": "medium",
                    "topic": "Working dogs",
                    "funFact": "Guide Dogs says crossing the two also widens the gene pool, giving healthier, longer-living dogs.",
                    "source": {
                        "name": "Guide Dogs UK — Crossbreeds",
                        "url": "https://www.guidedogs.org.uk/getting-support/guide-dogs/our-breeds/crossbreeds/"
                    }
                },
                {
                    "question": "Which fluffy, lion-maned breed originally from China is instantly identified by its blue-black tongue?",
                    "answer": "Chow Chow",
                    "acceptable": [
                        "Chow",
                        "Chowchow",
                        "Chow-Chow"
                    ],
                    "difficulty": "medium",
                    "topic": "Breed characteristics",
                    "funFact": "The breed standard wants a solid black mouth too — roof and flews, not just the tongue.",
                    "source": {
                        "name": "The Royal Kennel Club — Chow Chow breed standard",
                        "url": "https://www.royalkennelclub.com/breed-standards/utility/chow-chow/"
                    }
                },
                {
                    "question": "The Royal Kennel Club sorts pedigree dogs into seven groups: Hound, Working, Terrier, Gundog, Pastoral, Utility and Toy. Which group is the Border Collie in?",
                    "answer": "Pastoral",
                    "acceptable": [
                        "Pastoral Group",
                        "The Pastoral group",
                        "Pastoral dogs"
                    ],
                    "difficulty": "medium",
                    "topic": "Kennel Club groupings",
                    "funFact": "Pastoral covers herding breeds working cattle and sheep — and, in the Samoyed's case, reindeer.",
                    "source": {
                        "name": "The Royal Kennel Club — Border Collie (Breeds A to Z, Pastoral)",
                        "url": "https://www.royalkennelclub.com/search/breeds-a-to-z/breeds/pastoral/border-collie/"
                    }
                },
                {
                    "question": "The Kennel Club keeps a list of 'vulnerable native breeds' — British breeds at risk of dying out. One of the very rarest is a big, shaggy scent hound with a waterproof coat and webbed feet, bred to hunt in rivers. Which breed is it?",
                    "answer": "Otterhound",
                    "acceptable": [
                        "Otter hound",
                        "The Otterhound"
                    ],
                    "difficulty": "hard",
                    "topic": "Rare British breeds",
                    "funFact": "Its job vanished when otters became protected in 1978, and hunting them was banned outright by 1981.",
                    "source": {
                        "name": "BBC Countryfile Magazine — Otterhound breed facts",
                        "url": "https://www.countryfile.com/animals/pets/otterhound-dog-breed-facts"
                    }
                },
                {
                    "question": "At Crufts in March 2026, a dog called Bruin took Best in Show — the first win for his breed since 1991. He's a heavy, low-slung white spaniel named after a Nottinghamshire estate. Which breed is he?",
                    "answer": "Clumber Spaniel",
                    "acceptable": [
                        "Clumber",
                        "Clumber spaniel dog"
                    ],
                    "difficulty": "hard",
                    "topic": "Crufts",
                    "funFact": "Bruin is only the second Clumber Spaniel ever to lift Crufts' Keddell Memorial Trophy.",
                    "source": {
                        "name": "The Royal Kennel Club — Crufts 2026 Best in Show winner",
                        "url": "https://www.royalkennelclub.com/about-us/resources/media-centre/2026/march/crufts-2026-best-in-show-winner-bruin-the-clumber-spaniel-from-somerset/"
                    }
                }
            ]
        },
        {
            "id": "music-clips",
            "name": "Name That Tune",
            "icon": "🎵",
            "intro": "Ten clips, thirty seconds each. I want the name of the SONG on your sheet, not the artist — though shouting the artist at the ceiling is allowed and encouraged. No humming your answer at me; I will not accept it.",
            "questions": [
                {
                    "question": "Track one. Everybody in this room has heard this one, whether you wanted to or not. Listen to the clip and write down the title of the song.",
                    "answer": "Let It Go",
                    "acceptable": [
                        "Let It Go",
                        "Let It Go (from Frozen)",
                        "Letitgo",
                        "Let it go"
                    ],
                    "difficulty": "easy",
                    "topic": "Film soundtrack / Disney",
                    "funFact": "It won the Oscar for Best Original Song in 2014, yet Idina Menzel's version only ever reached Number 11 here.",
                    "clip": {
                        "source": "itunes",
                        "trackId": 1440618281,
                        "previewUrl": "https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview221/v4/43/5f/36/435f3609-ddd5-bc10-3dbb-ddf5872b93ce/mzaf_9461789858996596537.plus.aac.p.m4a",
                        "artist": "Idina Menzel",
                        "title": "Let It Go",
                        "year": 2013,
                        "storeUrl": "https://music.apple.com/gb/album/let-it-go/1440618177?i=1440618281&uo=4"
                    },
                    "source": {
                        "name": "Official Charts Company",
                        "url": "https://www.officialcharts.com/songs/idina-menzel-let-it-go/"
                    }
                },
                {
                    "question": "Track two. A ginger British singer-songwriter, a marimba loop and an extremely large 2017. Listen and name the song.",
                    "answer": "Shape of You",
                    "acceptable": [
                        "Shape of You",
                        "Shape Of You",
                        "The Shape of You"
                    ],
                    "difficulty": "easy",
                    "topic": "Pop / 2010s",
                    "funFact": "Sheeran wrote it thinking it would suit Rihanna, then kept it. Fourteen weeks at UK Number One followed.",
                    "clip": {
                        "source": "itunes",
                        "trackId": 1193683174,
                        "previewUrl": "https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview221/v4/e8/be/18/e8be18a2-f7eb-d88b-a5d5-9c09f6f6738c/mzaf_17234196611300958608.plus.aac.p.m4a",
                        "artist": "Ed Sheeran",
                        "title": "Shape of You",
                        "year": 2017,
                        "storeUrl": "https://music.apple.com/gb/album/shape-of-you/1193682944?i=1193683174&uo=4"
                    },
                    "source": {
                        "name": "Official Charts Company",
                        "url": "https://www.officialcharts.com/songs/ed-sheeran-shape-of-you/"
                    }
                },
                {
                    "question": "Track three. Brass, a strut of a bassline, and a video absolutely stuffed with shiny suits. Listen and name the song.",
                    "answer": "Uptown Funk",
                    "acceptable": [
                        "Uptown Funk",
                        "Uptown Funk!",
                        "Uptown Funk (feat. Bruno Mars)"
                    ],
                    "difficulty": "easy",
                    "topic": "Funk pop / 2010s",
                    "funFact": "It won Record of the Year at the 2016 Grammys and spent seven weeks at UK Number One.",
                    "clip": {
                        "source": "itunes",
                        "trackId": 956024318,
                        "previewUrl": "https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview211/v4/38/55/fe/3855feef-5884-9f0c-a1a5-5c1a9ff4e269/mzaf_16034847874510944537.plus.aac.p.m4a",
                        "artist": "Mark Ronson ft. Bruno Mars",
                        "title": "Uptown Funk",
                        "year": 2015,
                        "storeUrl": "https://music.apple.com/gb/album/uptown-funk-feat-bruno-mars/956024314?i=956024318&uo=4"
                    },
                    "source": {
                        "name": "Official Charts Company",
                        "url": "https://www.officialcharts.com/songs/mark-ronson-ft-bruno-mars-uptown-funk/"
                    }
                },
                {
                    "question": "Track four. Eighties-style synths, a Canadian falsetto, and a man in a red jacket with a bruised face. Listen and name the song.",
                    "answer": "Blinding Lights",
                    "acceptable": [
                        "Blinding Lights",
                        "Blinding Light",
                        "Blinding lights"
                    ],
                    "difficulty": "medium",
                    "topic": "Synth-pop / 2019",
                    "funFact": "It gave up the UK Number One when the Weeknd asked fans to back Captain Tom Moore's charity single instead.",
                    "clip": {
                        "source": "itunes",
                        "trackId": 1488408568,
                        "previewUrl": "https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview211/v4/17/b4/8f/17b48f9a-0b93-6bb8-fe1d-3a16623c2cfb/mzaf_9560252727299052414.plus.aac.p.m4a",
                        "artist": "The Weeknd",
                        "title": "Blinding Lights",
                        "year": 2019,
                        "storeUrl": "https://music.apple.com/gb/album/blinding-lights/1488408555?i=1488408568&uo=4"
                    },
                    "source": {
                        "name": "Wikipedia",
                        "url": "https://en.wikipedia.org/wiki/Blinding_Lights"
                    }
                },
                {
                    "question": "Track five. That voice is completely unmistakable — an Australian street performer who went from busking to a global smash. Listen and name the song.",
                    "answer": "Dance Monkey",
                    "acceptable": [
                        "Dance Monkey",
                        "Dance, Monkey",
                        "Dancing Monkey"
                    ],
                    "difficulty": "medium",
                    "topic": "Pop / 2019",
                    "funFact": "She wrote it while busking, about the pressure to keep entertaining strangers in the street.",
                    "clip": {
                        "source": "itunes",
                        "trackId": 1475546088,
                        "previewUrl": "https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview221/v4/45/72/4f/45724fc8-2e85-d5b1-dda0-775958e9b692/mzaf_1626542530959622659.plus.aac.p.m4a",
                        "artist": "Tones and I",
                        "title": "Dance Monkey",
                        "year": 2019,
                        "storeUrl": "https://music.apple.com/gb/album/dance-monkey/1475546087?i=1475546088&uo=4"
                    },
                    "source": {
                        "name": "Official Charts Company",
                        "url": "https://www.officialcharts.com/songs/tones-i-dance-monkey/"
                    }
                },
                {
                    "question": "Track six. A stomping drumbeat and a voice from Tottenham that defined 2011. Listen and name the song.",
                    "answer": "Rolling in the Deep",
                    "acceptable": [
                        "Rolling in the Deep",
                        "Rolling In The Deep",
                        "Rollin' in the Deep"
                    ],
                    "difficulty": "medium",
                    "topic": "Soul pop / 2010s",
                    "funFact": "It never reached Number One here, stuck behind Bruno Mars, yet spent 65 weeks on the chart.",
                    "clip": {
                        "source": "itunes",
                        "trackId": 403037877,
                        "previewUrl": "https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview221/v4/84/ab/e5/84abe549-c9d6-3de2-cdd0-90e9256a637e/mzaf_7958095177960014950.plus.aac.p.m4a",
                        "artist": "Adele",
                        "title": "Rolling in the Deep",
                        "year": 2010,
                        "storeUrl": "https://music.apple.com/gb/album/rolling-in-the-deep/403037872?i=403037877&uo=4"
                    },
                    "source": {
                        "name": "Official Charts Company",
                        "url": "https://www.officialcharts.com/songs/adele-rolling-in-the-deep/"
                    }
                },
                {
                    "question": "Track seven. A Las Vegas band, and the song that has closed every indie disco and wedding in Britain for two decades. Listen and name the song.",
                    "answer": "Mr. Brightside",
                    "acceptable": [
                        "Mr. Brightside",
                        "Mr Brightside",
                        "Mister Brightside"
                    ],
                    "difficulty": "medium",
                    "topic": "Indie rock / 2000s",
                    "funFact": "Official Charts calls it the longest-running hit ever, and the UK's biggest song never to reach Number One.",
                    "clip": {
                        "source": "itunes",
                        "trackId": 1440717826,
                        "previewUrl": "https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview221/v4/b2/1a/e8/b21ae8eb-9d11-2aaf-cc48-0e8ca210c485/mzaf_18420207698003017244.plus.aac.p.m4a",
                        "artist": "The Killers",
                        "title": "Mr. Brightside",
                        "year": 2003,
                        "storeUrl": "https://music.apple.com/gb/album/mr-brightside/1440717563?i=1440717826&uo=4"
                    },
                    "source": {
                        "name": "Official Charts Company",
                        "url": "https://www.officialcharts.com/songs/killers-mr-brightside/"
                    }
                },
                {
                    "question": "Track eight. The oldest clip of the night — this record is older than every single person sitting in this room. Listen and name the song.",
                    "answer": "Twist and Shout",
                    "acceptable": [
                        "Twist and Shout",
                        "Twist & Shout",
                        "Shake It Up Baby"
                    ],
                    "difficulty": "medium",
                    "topic": "Rock and roll / 1963",
                    "funFact": "Lennon sang it in one take with a shredded voice; a second attempt was abandoned entirely.",
                    "clip": {
                        "source": "itunes",
                        "trackId": 1441165136,
                        "previewUrl": "https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview211/v4/a1/da/74/a1da7475-c355-8ecf-f46a-2ba0e8571561/mzaf_6982524764313957424.plus.aac.p.m4a",
                        "artist": "The Beatles",
                        "title": "Twist and Shout",
                        "year": 1963,
                        "storeUrl": "https://music.apple.com/gb/album/twist-and-shout/1441164816?i=1441165136&uo=4"
                    },
                    "source": {
                        "name": "Official Charts Company",
                        "url": "https://www.officialcharts.com/songs/the-beatles-twist-and-shout/"
                    }
                },
                {
                    "question": "Track nine. There is a laugh in this one, and then that bassline arrives. A cartoon band, if that helps. Listen and name the song.",
                    "answer": "Feel Good Inc.",
                    "acceptable": [
                        "Feel Good Inc.",
                        "Feel Good Inc",
                        "Feel Good Incorporated"
                    ],
                    "difficulty": "hard",
                    "topic": "Alternative hip-hop / 2005",
                    "funFact": "That laugh is De La Soul's Vincent Mason, cracking up at the music being made in the studio.",
                    "clip": {
                        "source": "itunes",
                        "trackId": 850583586,
                        "previewUrl": "https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview221/v4/81/59/e0/8159e01e-fa32-c607-f76c-f3fd4f95192a/mzaf_15903337756715110889.plus.aac.p.m4a",
                        "artist": "Gorillaz",
                        "title": "Feel Good Inc.",
                        "year": 2005,
                        "storeUrl": "https://music.apple.com/gb/album/feel-good-inc/850583573?i=850583586&uo=4"
                    },
                    "source": {
                        "name": "Wikipedia",
                        "url": "https://en.wikipedia.org/wiki/Feel_Good_Inc."
                    }
                },
                {
                    "question": "Track ten, and the hardest. A Glasgow band with an Italian-sounding name, and a 'da-da-da' singalong you have heard bellowed at a hundred football grounds without ever learning its title. Listen and name the song.",
                    "answer": "Chelsea Dagger",
                    "acceptable": [
                        "Chelsea Dagger",
                        "The Chelsea Dagger",
                        "Chelsea Dagger (Radio Edit)"
                    ],
                    "difficulty": "hard",
                    "topic": "Indie rock / 2006",
                    "funFact": "Named after the singer's wife's burlesque stage name, it is now the Chicago Blackhawks' goal song.",
                    "clip": {
                        "source": "itunes",
                        "trackId": 1440783311,
                        "previewUrl": "https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview211/v4/e4/52/8b/e4528b1d-0bab-7f2d-b935-43f935cffb0c/mzaf_16286667099988702087.plus.aac.p.m4a",
                        "artist": "The Fratellis",
                        "title": "Chelsea Dagger",
                        "year": 2006,
                        "storeUrl": "https://music.apple.com/gb/album/chelsea-dagger/1440782897?i=1440783311&uo=4"
                    },
                    "source": {
                        "name": "Official Charts Company",
                        "url": "https://www.officialcharts.com/songs/fratellis-chelsea-dagger/"
                    }
                }
            ]
        },
        {
            "id": "films-2020s",
            "name": "Films of the 2020s",
            "icon": "🎬",
            "intro": "Every question in this round comes from a film released in 2020 or later — nothing older sneaks in. Cinema tickets, Christmas Day telly and the odd Oscar: ten questions on the decade so far.",
            "questions": [
                {
                    "question": "In Disney's Encanto, released in 2021, the Madrigal family have a smash-hit song about an outcast uncle they refuse to discuss. What is his name?",
                    "answer": "Bruno",
                    "acceptable": [
                        "Bruno Madrigal",
                        "Uncle Bruno"
                    ],
                    "difficulty": "easy",
                    "topic": "Disney animation",
                    "funFact": "We Don't Talk About Bruno was the first ever original Disney song to top the UK Singles Chart.",
                    "source": {
                        "name": "Wikipedia — List of Encanto characters",
                        "url": "https://en.wikipedia.org/wiki/List_of_Encanto_characters"
                    }
                },
                {
                    "question": "In Pixar's Inside Out 2, released in 2024, a new orange emotion moves into teenage Riley's head and takes over headquarters. Which emotion is she?",
                    "answer": "Anxiety",
                    "acceptable": [
                        "Anxious",
                        "Anxiety, voiced by Maya Hawke"
                    ],
                    "difficulty": "easy",
                    "topic": "Pixar animation",
                    "funFact": "It took 1.7 billion dollars and was the highest-grossing animated film ever made, a record it has since lost twice.",
                    "source": {
                        "name": "Wikipedia — Anxiety (Inside Out)",
                        "url": "https://en.wikipedia.org/wiki/Anxiety_(Inside_Out)"
                    }
                },
                {
                    "question": "Margot Robbie played the title role in Greta Gerwig's 2023 film Barbie. Which Canadian actor played the lead Ken, and was Oscar-nominated for the role?",
                    "answer": "Ryan Gosling",
                    "acceptable": [
                        "Gosling"
                    ],
                    "difficulty": "easy",
                    "topic": "Live-action blockbusters",
                    "funFact": "Barbie was shot at Warner Bros. Studios Leavesden in Hertfordshire, home of the Harry Potter films.",
                    "source": {
                        "name": "Wikipedia — Barbie (film)",
                        "url": "https://en.wikipedia.org/wiki/Barbie_(film)"
                    }
                },
                {
                    "question": "In The Super Mario Bros. Movie of 2023, which actor voiced the villain Bowser and sang his love ballad Peaches?",
                    "answer": "Jack Black",
                    "acceptable": [
                        "Black",
                        "Jack Black, the Tenacious D singer"
                    ],
                    "difficulty": "medium",
                    "topic": "Video game animation",
                    "funFact": "Co-director Aaron Horvath first imagined a heavy metal number for Bowser; a soppy piano ballad won out instead.",
                    "source": {
                        "name": "Wikipedia — The Super Mario Bros. Movie",
                        "url": "https://en.wikipedia.org/wiki/The_Super_Mario_Bros._Movie"
                    }
                },
                {
                    "question": "Wallace & Gromit: Vengeance Most Fowl went out on BBC One on Christmas Day 2024. Which penguin supervillain made his return in it?",
                    "answer": "Feathers McGraw",
                    "acceptable": [
                        "Feathers",
                        "McGraw"
                    ],
                    "difficulty": "medium",
                    "topic": "British animation",
                    "funFact": "Feathers first robbed Wallace in 1993's The Wrong Trousers, disguised as a chicken with a red rubber glove.",
                    "source": {
                        "name": "Wikipedia — Wallace & Gromit: Vengeance Most Fowl",
                        "url": "https://en.wikipedia.org/wiki/Wallace_%26_Gromit:_Vengeance_Most_Fowl"
                    }
                },
                {
                    "question": "Which James Cameron sequel was the highest-grossing film worldwide of 2022, taking over 2.3 billion dollars?",
                    "answer": "Avatar: The Way of Water",
                    "acceptable": [
                        "The Way of Water",
                        "Avatar 2",
                        "Avatar Two"
                    ],
                    "difficulty": "medium",
                    "topic": "Box office",
                    "funFact": "It arrived thirteen years after the first Avatar, which is still the highest-grossing film ever made.",
                    "source": {
                        "name": "Box Office Mojo — 2022 Worldwide Box Office",
                        "url": "https://www.boxofficemojo.com/year/world/2022/"
                    }
                },
                {
                    "question": "Which Irish actor won the Best Actor Oscar in 2024 for playing the physicist J. Robert Oppenheimer?",
                    "answer": "Cillian Murphy",
                    "acceptable": [
                        "Murphy",
                        "Killian Murphy"
                    ],
                    "difficulty": "medium",
                    "topic": "Oscars",
                    "funFact": "Oppenheimer won seven Oscars that night, including Best Picture and Best Director for Christopher Nolan.",
                    "source": {
                        "name": "Wikipedia — 96th Academy Awards",
                        "url": "https://en.wikipedia.org/wiki/96th_Academy_Awards"
                    }
                },
                {
                    "question": "Which British actor has provided the voice of Paddington in all three films, including Paddington in Peru in 2024?",
                    "answer": "Ben Whishaw",
                    "acceptable": [
                        "Whishaw",
                        "Ben Wishaw"
                    ],
                    "difficulty": "medium",
                    "topic": "British family films",
                    "funFact": "Olivia Colman joined as the Reverend Mother, while Emily Mortimer replaced Sally Hawkins as Mrs Brown.",
                    "source": {
                        "name": "Wikipedia — Paddington in Peru",
                        "url": "https://en.wikipedia.org/wiki/Paddington_in_Peru"
                    }
                },
                {
                    "question": "Which low-budget independent film beat Conclave, The Brutalist and Wicked to win Best Picture at the Academy Awards in March 2025?",
                    "answer": "Anora",
                    "acceptable": [
                        "Anora, 2024",
                        "Annora"
                    ],
                    "difficulty": "hard",
                    "topic": "Oscars",
                    "funFact": "Its director Sean Baker won four Oscars in one night, a feat matched only by Walt Disney in 1954.",
                    "source": {
                        "name": "Wikipedia — 97th Academy Awards",
                        "url": "https://en.wikipedia.org/wiki/97th_Academy_Awards"
                    }
                },
                {
                    "question": "In 2025 a Chinese animated fantasy became the highest-grossing animated film of all time, taking over 2.2 billion dollars. Name it.",
                    "answer": "Ne Zha 2",
                    "acceptable": [
                        "Nezha 2",
                        "Ne Zha II",
                        "Nezha II",
                        "Ne Zha Two"
                    ],
                    "difficulty": "hard",
                    "topic": "World cinema and box office",
                    "funFact": "It was the first animated film ever to pass two billion dollars, and almost all of that came from China.",
                    "source": {
                        "name": "Wikipedia — List of highest-grossing animated films",
                        "url": "https://en.wikipedia.org/wiki/List_of_highest-grossing_animated_films"
                    }
                }
            ]
        },
        {
            "id": "food-treats",
            "name": "Food & Treats",
            "icon": "🍫",
            "intro": "Right, pens down and stomachs rumbling — this round is all sweets, snacks, takeaways and trolley staples. If you have ever queued in a Greggs or fought over the purple one, you are already qualified.",
            "questions": [
                {
                    "question": "What is the name of the caterpillar-shaped chocolate cake sold by Marks & Spencer?",
                    "answer": "Colin the Caterpillar",
                    "acceptable": [
                        "Colin",
                        "Colin the caterpillar cake",
                        "M&S Colin"
                    ],
                    "difficulty": "easy",
                    "topic": "Supermarket cakes",
                    "funFact": "M&S sued Aldi in April 2021 over its rival Cuthbert the Caterpillar. They settled in February 2022 for an undisclosed sum.",
                    "source": {
                        "name": "Wikipedia — Colin the Caterpillar",
                        "url": "https://en.wikipedia.org/wiki/Colin_the_Caterpillar"
                    }
                },
                {
                    "question": "Which frog-shaped Cadbury chocolate bar is so cheap and so familiar that British newspapers use its price as an unofficial measure of inflation?",
                    "answer": "Freddo",
                    "acceptable": [
                        "Cadbury Freddo",
                        "Freddo Frog",
                        "The Freddo"
                    ],
                    "difficulty": "easy",
                    "topic": "Chocolate",
                    "funFact": "A Freddo stayed at 10p right up to 2005, then rose roughly 2p a year. Every rise brings fresh national outrage.",
                    "source": {
                        "name": "Wikipedia — Freddo",
                        "url": "https://en.wikipedia.org/wiki/Freddo"
                    }
                },
                {
                    "question": "In 2019, which high-street bakery chain caused a national fuss by launching a vegan sausage roll made with Quorn?",
                    "answer": "Greggs",
                    "acceptable": [
                        "Greggs bakery",
                        "Gregg's",
                        "Greggs the bakers"
                    ],
                    "difficulty": "easy",
                    "topic": "Bakeries and high street food",
                    "funFact": "It became one of the company's five best-selling products and contributed to a 50 per cent increase in their profits.",
                    "source": {
                        "name": "Wikipedia — Meat-free sausage roll",
                        "url": "https://en.wikipedia.org/wiki/Meat-free_sausage_roll"
                    }
                },
                {
                    "question": "Which brightly coloured hydration drink, founded in 2022 by YouTubers KSI and Logan Paul, caused chaotic scenes and queues in Asda and Aldi?",
                    "answer": "Prime",
                    "acceptable": [
                        "Prime Hydration",
                        "Prime drink"
                    ],
                    "difficulty": "medium",
                    "topic": "Soft drinks",
                    "funFact": "Bottles priced around two pounds in supermarkets were being resold online for absurd sums during the shortage.",
                    "source": {
                        "name": "Wikipedia — Prime (drink)",
                        "url": "https://en.wikipedia.org/wiki/Prime_(drink)"
                    }
                },
                {
                    "question": "An ice cream van sells you a '99'. Which chocolate bar is stuck into the top of the cone?",
                    "answer": "A Flake",
                    "acceptable": [
                        "Flake",
                        "Cadbury Flake",
                        "A Cadbury Flake",
                        "Chocolate flake",
                        "99 Flake"
                    ],
                    "difficulty": "medium",
                    "topic": "Ice cream",
                    "funFact": "Flake was created in 1920 after a Cadbury worker spotted thin streams of surplus chocolate falling from moulds and cooling into flaky ripples.",
                    "source": {
                        "name": "Wikipedia — 99 Flake",
                        "url": "https://en.wikipedia.org/wiki/99_Flake"
                    }
                },
                {
                    "question": "In a tin of Quality Street, what two things are inside the famous sweet in the purple wrapper?",
                    "answer": "Hazelnut and caramel",
                    "acceptable": [
                        "Hazelnut in caramel",
                        "Caramel and hazelnut",
                        "Hazelnut caramel",
                        "Hazelnut and toffee",
                        "Hazelnut, caramel and chocolate",
                        "A hazelnut in caramel in milk chocolate"
                    ],
                    "difficulty": "medium",
                    "topic": "Confectionery",
                    "funFact": "The Purple One originally contained a brazil nut. Post-war supply shortages swapped it for the hazelnut we get today.",
                    "source": {
                        "name": "Nestlé Confectionery UK — The Ultimate Guide to Quality Street Flavours",
                        "url": "https://www.nestle-confectionery.co.uk/did-you-know/quality-street-flavours"
                    }
                },
                {
                    "question": "In 2017 The Great British Bake Off returned on a new channel after leaving the BBC. Which channel?",
                    "answer": "Channel 4",
                    "acceptable": [
                        "C4",
                        "Four",
                        "Channel Four"
                    ],
                    "difficulty": "medium",
                    "topic": "Television and baking",
                    "funFact": "The first series on the new channel ran from 29 August to 31 October 2017, and was the programme's eighth series overall.",
                    "source": {
                        "name": "Wikipedia — The Great British Bake Off (series 8)",
                        "url": "https://en.wikipedia.org/wiki/The_Great_British_Bake_Off_(series_8)"
                    }
                },
                {
                    "question": "In 2001 Foreign Secretary Robin Cook called which curry house dish 'a true British national dish'?",
                    "answer": "Chicken tikka masala",
                    "acceptable": [
                        "Tikka masala",
                        "CTM",
                        "Chicken tikka masaala"
                    ],
                    "difficulty": "medium",
                    "topic": "Curry and national dishes",
                    "funFact": "Cook's point was that the chicken tikka is Indian, but the creamy sauce was added to give the British their gravy.",
                    "source": {
                        "name": "Wikipedia — Chicken tikka masala",
                        "url": "https://en.wikipedia.org/wiki/Chicken_tikka_masala"
                    }
                },
                {
                    "question": "In 1847 a Bristol family firm moulded what is generally considered the world's first chocolate bar made for eating. What was the company called?",
                    "answer": "Fry's",
                    "acceptable": [
                        "Fry",
                        "Frys",
                        "J. S. Fry & Sons",
                        "J S Fry and Sons",
                        "Fry and Sons",
                        "Joseph Fry",
                        "Fry's of Bristol"
                    ],
                    "difficulty": "hard",
                    "topic": "Confectionery history",
                    "funFact": "Fry's Chocolate Cream, launched in 1866, is still on sale and is reckoned to be the world's oldest chocolate bar brand.",
                    "source": {
                        "name": "Wikipedia — J. S. Fry & Sons",
                        "url": "https://en.wikipedia.org/wiki/J._S._Fry_%26_Sons"
                    }
                },
                {
                    "question": "In 2023 Guinness World Records crowned a new world's hottest chilli pepper, taking the title from the Carolina Reaper. What is the new one called?",
                    "answer": "Pepper X",
                    "acceptable": [
                        "The Pepper X",
                        "X pepper"
                    ],
                    "difficulty": "hard",
                    "topic": "Chillies and record breakers",
                    "funFact": "Pepper X averages 2,693,000 Scoville heat units, which is several hundred times hotter than an ordinary jalapeño.",
                    "source": {
                        "name": "Guinness World Records",
                        "url": "https://www.guinnessworldrecords.com/news/2023/10/pepper-x-dethrones-carolina-reaper-as-worlds-hottest-chilli-pepper-759706"
                    }
                }
            ]
        },
        {
            "id": "logos-b",
            "name": "Guess the Logo, Take Two",
            "icon": "🏷️",
            "intro": "Ten more marks with the names taken off. Every one of these is on a British high street, in somebody's phone, or on a pair of trainers in this room — which is exactly why it is annoying when the name will not come. Shout out the brand, not the shape.",
            "questions": [
                {
                    "question": "Whose logo is this?",
                    "answer": "McDonald's",
                    "acceptable": [
                        "McDonalds",
                        "Mc Donalds",
                        "Macdonalds",
                        "The Golden Arches",
                        "Golden Arches",
                        "Maccies",
                        "Maccy D's",
                        "McD's"
                    ],
                    "difficulty": "easy",
                    "topic": "Logos",
                    "funFact": "The first arches were real: two 25-foot yellow sheet-metal arches trimmed in neon, on a restaurant opened in 1953.",
                    "image": {
                        "src": "images/logos-b/logo-b-01.png",
                        "alt": "A company logo",
                        "fit": "contain",
                        "plate": "dark",
                        "credit": "Simple Icons",
                        "license": "CC0 1.0",
                        "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
                        "sourceUrl": "https://simpleicons.org/",
                        "trademark": true
                    },
                    "source": {
                        "name": "Wikipedia: Golden Arches",
                        "url": "https://en.wikipedia.org/wiki/Golden_Arches"
                    }
                },
                {
                    "question": "Whose logo is this?",
                    "answer": "Spotify",
                    "acceptable": [
                        "Spotify AB",
                        "Spotify Technology",
                        "Spotify Premium"
                    ],
                    "difficulty": "easy",
                    "topic": "Logos",
                    "funFact": "It opened to European listeners in October 2008, but Americans had to wait until July 2011.",
                    "image": {
                        "src": "images/logos-b/logo-b-02.png",
                        "alt": "A company logo",
                        "fit": "contain",
                        "plate": "dark",
                        "credit": "Simple Icons",
                        "license": "CC0 1.0",
                        "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
                        "sourceUrl": "https://simpleicons.org/",
                        "trademark": true
                    },
                    "source": {
                        "name": "Wikipedia: Spotify",
                        "url": "https://en.wikipedia.org/wiki/Spotify"
                    }
                },
                {
                    "question": "Whose logo is this?",
                    "answer": "TikTok",
                    "acceptable": [
                        "Tik Tok",
                        "Tiktok",
                        "Tick Tock"
                    ],
                    "difficulty": "easy",
                    "topic": "Logos",
                    "funFact": "It launched outside China in 2017, and in August 2018 it swallowed rival Musical.ly, folding every account into one app.",
                    "image": {
                        "src": "images/logos-b/logo-b-03.png",
                        "alt": "A company logo",
                        "fit": "contain",
                        "plate": "light",
                        "credit": "Simple Icons",
                        "license": "CC0 1.0",
                        "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
                        "sourceUrl": "https://simpleicons.org/",
                        "trademark": true
                    },
                    "source": {
                        "name": "Wikipedia: TikTok",
                        "url": "https://en.wikipedia.org/wiki/TikTok"
                    }
                },
                {
                    "question": "Whose logo is this?",
                    "answer": "Adidas",
                    "acceptable": [
                        "adidas",
                        "Adidas AG",
                        "Addidas"
                    ],
                    "difficulty": "medium",
                    "topic": "Logos",
                    "funFact": "The story goes that it bought the three stripes from Finland's Karhu Sports in 1952 for two bottles of whisky and about 1,600 euros.",
                    "image": {
                        "src": "images/logos-b/logo-b-04.png",
                        "alt": "A company logo",
                        "fit": "contain",
                        "plate": "light",
                        "credit": "Simple Icons",
                        "license": "CC0 1.0",
                        "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
                        "sourceUrl": "https://simpleicons.org/",
                        "trademark": true
                    },
                    "source": {
                        "name": "Wikipedia: Adidas",
                        "url": "https://en.wikipedia.org/wiki/Adidas"
                    }
                },
                {
                    "question": "Whose logo is this?",
                    "answer": "Starbucks",
                    "acceptable": [
                        "Starbucks Coffee",
                        "Starbucks Corporation",
                        "Star Bucks"
                    ],
                    "difficulty": "medium",
                    "topic": "Logos",
                    "funFact": "In 2011 it took its own name out of the logo, leaving the twin-tailed siren on her own.",
                    "image": {
                        "src": "images/logos-b/logo-b-05.png",
                        "alt": "A company logo",
                        "fit": "contain",
                        "plate": "light",
                        "credit": "Simple Icons",
                        "license": "CC0 1.0",
                        "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
                        "sourceUrl": "https://simpleicons.org/",
                        "trademark": true
                    },
                    "source": {
                        "name": "Wikipedia: Starbucks",
                        "url": "https://en.wikipedia.org/wiki/Starbucks"
                    }
                },
                {
                    "question": "Whose logo is this?",
                    "answer": "Duolingo",
                    "acceptable": [
                        "Duo",
                        "Duo the Owl",
                        "The Duolingo owl",
                        "Dualingo",
                        "Duo Lingo"
                    ],
                    "difficulty": "medium",
                    "topic": "Logos",
                    "funFact": "The owl is green because co-founder Severin Hacker hates the colour green.",
                    "image": {
                        "src": "images/logos-b/logo-b-06.png",
                        "alt": "A company logo",
                        "fit": "contain",
                        "plate": "dark",
                        "credit": "Simple Icons",
                        "license": "CC0 1.0",
                        "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
                        "sourceUrl": "https://simpleicons.org/",
                        "trademark": true
                    },
                    "source": {
                        "name": "Wikipedia: Duolingo",
                        "url": "https://en.wikipedia.org/wiki/Duolingo"
                    }
                },
                {
                    "question": "Whose logo is this?",
                    "answer": "Deliveroo",
                    "acceptable": [
                        "Roofoods",
                        "Roofoods Ltd",
                        "Deliveroo plc"
                    ],
                    "difficulty": "medium",
                    "topic": "Logos",
                    "funFact": "The London firm launched in 2013, and the American giant DoorDash took it over in October 2025.",
                    "image": {
                        "src": "images/logos-b/logo-b-07.png",
                        "alt": "A company logo",
                        "fit": "contain",
                        "plate": "dark",
                        "credit": "Simple Icons",
                        "license": "CC0 1.0",
                        "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
                        "sourceUrl": "https://simpleicons.org/",
                        "trademark": true
                    },
                    "source": {
                        "name": "Wikipedia: Deliveroo",
                        "url": "https://en.wikipedia.org/wiki/Deliveroo"
                    }
                },
                {
                    "question": "Whose logo is this?",
                    "answer": "The Premier League",
                    "acceptable": [
                        "Premier League",
                        "English Premier League",
                        "EPL",
                        "The Prem",
                        "The Premiership",
                        "Premiership"
                    ],
                    "difficulty": "medium",
                    "topic": "Logos",
                    "funFact": "The lion was redrawn for a new visual identity brought in for the 2016-17 season.",
                    "image": {
                        "src": "images/logos-b/logo-b-08.png",
                        "alt": "A sports competition logo",
                        "fit": "contain",
                        "plate": "light",
                        "credit": "Simple Icons",
                        "license": "CC0 1.0",
                        "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
                        "sourceUrl": "https://simpleicons.org/",
                        "trademark": true
                    },
                    "source": {
                        "name": "Premier League: new visual identity",
                        "url": "https://www.premierleague.com/en/news/60917"
                    }
                },
                {
                    "question": "Whose logo is this?",
                    "answer": "Just Eat",
                    "acceptable": [
                        "JustEat",
                        "Just-Eat",
                        "Just Eat Takeaway",
                        "Just Eat Takeaway.com"
                    ],
                    "difficulty": "hard",
                    "topic": "Logos",
                    "funFact": "It started in Denmark in 2001, and from 2020 Snoop Dogg appeared in its adverts.",
                    "image": {
                        "src": "images/logos-b/logo-b-09.png",
                        "alt": "A company logo",
                        "fit": "contain",
                        "plate": "dark",
                        "credit": "Simple Icons",
                        "license": "CC0 1.0",
                        "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
                        "sourceUrl": "https://simpleicons.org/",
                        "trademark": true
                    },
                    "source": {
                        "name": "Wikipedia: Just Eat",
                        "url": "https://en.wikipedia.org/wiki/Just_Eat"
                    }
                },
                {
                    "question": "Whose logo is this?",
                    "answer": "Meta",
                    "acceptable": [
                        "Meta Platforms",
                        "Meta Platforms Inc",
                        "Meta Inc"
                    ],
                    "difficulty": "hard",
                    "topic": "Logos",
                    "funFact": "Facebook the company renamed itself in October 2021, while Facebook the app kept its own name.",
                    "image": {
                        "src": "images/logos-b/logo-b-10.png",
                        "alt": "A company logo",
                        "fit": "contain",
                        "plate": "light",
                        "credit": "Simple Icons",
                        "license": "CC0 1.0",
                        "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
                        "sourceUrl": "https://simpleicons.org/",
                        "trademark": true
                    },
                    "source": {
                        "name": "Wikipedia: Meta Platforms",
                        "url": "https://en.wikipedia.org/wiki/Meta_Platforms"
                    }
                }
            ]
        },
        {
            "id": "f1",
            "name": "Formula One",
            "icon": "🏎️",
            "intro": "Ten questions from the world of Formula One — lights out on the Netflix and Brad Pitt era, a quick detour to 1950, and then we go record hunting. You do not need to be a fan to get off the line.",
            "questions": [
                {
                    "question": "Which hit Netflix documentary series goes behind the scenes of each Formula One season and is credited with winning the sport a whole new audience?",
                    "answer": "Drive to Survive",
                    "acceptable": [
                        "Formula 1: Drive to Survive",
                        "F1: Drive to Survive",
                        "Drive To Survive",
                        "DTS"
                    ],
                    "difficulty": "easy",
                    "topic": "Television",
                    "funFact": "It first landed on Netflix in March 2019 and is widely credited with pulling millions of new fans into Formula One.",
                    "source": {
                        "name": "Wikipedia – Formula 1: Drive to Survive",
                        "url": "https://en.wikipedia.org/wiki/Formula_1:_Drive_to_Survive"
                    }
                },
                {
                    "question": "Which Hollywood star played veteran driver Sonny Hayes in the 2025 blockbuster 'F1: The Movie'?",
                    "answer": "Brad Pitt",
                    "acceptable": [
                        "Pitt",
                        "Bradley Pitt",
                        "Brad Pit"
                    ],
                    "difficulty": "easy",
                    "topic": "Film",
                    "funFact": "Shot at real Grand Prix weekends: filming began at the 2023 British Grand Prix, with cameras later at Spa, Monza and Suzuka.",
                    "source": {
                        "name": "Formula 1 (formula1.com)",
                        "url": "https://www.formula1.com/en/latest/article/brad-pitt-extraordinary-shooting-apple-original-films-f1-the-movie.58UryF4gery7Iem3Rap9hC"
                    }
                },
                {
                    "question": "Which Grand Prix on the current Formula One calendar is run on public streets around a millionaires' harbour, past a famous casino and through a seafront tunnel?",
                    "answer": "Monaco",
                    "acceptable": [
                        "The Monaco Grand Prix",
                        "Monaco GP",
                        "Monte Carlo",
                        "Circuit de Monaco"
                    ],
                    "difficulty": "easy",
                    "topic": "Circuits",
                    "funFact": "The 3.337km lap runs on public streets around the harbour of Monte Carlo, past Casino Square and through a tunnel.",
                    "source": {
                        "name": "Wikipedia – Circuit de Monaco",
                        "url": "https://en.wikipedia.org/wiki/Circuit_de_Monaco"
                    }
                },
                {
                    "question": "Max Verstappen won four drivers' world championships in a row, from 2021 to 2024. Which team was he driving for?",
                    "answer": "Red Bull",
                    "acceptable": [
                        "Red Bull Racing",
                        "Oracle Red Bull Racing",
                        "Red Bull Racing Honda"
                    ],
                    "difficulty": "medium",
                    "topic": "Teams and drivers",
                    "funFact": "Four in a row put Verstappen level with Alain Prost and Sebastian Vettel on four world titles.",
                    "source": {
                        "name": "Wikipedia – Max Verstappen",
                        "url": "https://en.wikipedia.org/wiki/Max_Verstappen"
                    }
                },
                {
                    "question": "At the 2025 season finale in Abu Dhabi, which British driver was crowned Formula One World Champion for the first time?",
                    "answer": "Lando Norris",
                    "acceptable": [
                        "Norris",
                        "Lando"
                    ],
                    "difficulty": "medium",
                    "topic": "Champions",
                    "funFact": "He finished third in Abu Dhabi and took the title by just two points, 423 to 421.",
                    "source": {
                        "name": "FIA",
                        "url": "https://www.fia.com/news/f1-norris-crowned-fia-formula-one-world-champion-verstappen-takes-abu-dhabi-win"
                    }
                },
                {
                    "question": "What one-word name is given to the curved titanium bar fitted above the cockpit of every Formula One car since 2018 to protect the driver's head?",
                    "answer": "The halo",
                    "acceptable": [
                        "Halo"
                    ],
                    "difficulty": "medium",
                    "topic": "Safety and rules",
                    "funFact": "Mercedes reckoned the titanium halo, which weighs about nine kilos, is strong enough to hold the weight of a bus.",
                    "source": {
                        "name": "Formula 1 (formula1.com)",
                        "url": "https://www.formula1.com/en/latest/article.halo-protection-system-to-be-introduced-for-2018.2jhITmhSiwkKwOAWOG0UM6.html"
                    }
                },
                {
                    "question": "The very first race of the Formula One World Championship was held in Britain in May 1950. At which circuit?",
                    "answer": "Silverstone",
                    "acceptable": [
                        "Silverstone Circuit",
                        "Silverstone, Northamptonshire"
                    ],
                    "difficulty": "medium",
                    "topic": "History",
                    "funFact": "Italy's Giuseppe Farina won it in an Alfa Romeo, watched by King George VI.",
                    "source": {
                        "name": "Silverstone Circuit (official site)",
                        "url": "https://www.silverstone.co.uk/about/history-grand-prix"
                    }
                },
                {
                    "question": "Which Italian company has been the sole tyre supplier to every Formula One team since 2011?",
                    "answer": "Pirelli",
                    "acceptable": [
                        "Pirelli Tyres",
                        "Pirelli Tyres Ltd"
                    ],
                    "difficulty": "medium",
                    "topic": "Tyres",
                    "funFact": "Pirelli were also there for Formula One's very first season in 1950; the current deal runs to 2028.",
                    "source": {
                        "name": "Formula 1 (formula1.com)",
                        "url": "https://www.formula1.com/en/latest/article/formula-1-and-fia-announce-extension-of-pirellis-global-tyre-partnership-through-2028.7zmagtUQMH0KGPsvBcIqAF"
                    }
                },
                {
                    "question": "Which team won a record eight Formula One Constructors' Championships in a row, from 2014 to 2021?",
                    "answer": "Mercedes",
                    "acceptable": [
                        "Mercedes-AMG",
                        "Mercedes-Benz",
                        "Mercedes AMG Petronas",
                        "Merc"
                    ],
                    "difficulty": "hard",
                    "topic": "Teams",
                    "funFact": "Eight in a row is still the record. The team is based at Brackley, just up the road from Silverstone.",
                    "source": {
                        "name": "Guinness World Records",
                        "url": "https://www.guinnessworldrecords.com/world-records/636368-most-consecutive-formula-one-constructors-world-championship-titles"
                    }
                },
                {
                    "question": "Lewis Hamilton holds the all-time Formula One record for the most pole positions in a career. To the nearest ten, how many has he taken?",
                    "answer": "104",
                    "acceptable": [
                        "100",
                        "One hundred",
                        "104 poles",
                        "One hundred and four",
                        "A hundred and four"
                    ],
                    "difficulty": "hard",
                    "topic": "Records",
                    "funFact": "His first pole came in 2007 and his 104th at the 2023 Hungarian Grand Prix. Michael Schumacher is second on 68.",
                    "source": {
                        "name": "Guinness World Records",
                        "url": "https://www.guinnessworldrecords.com/world-records/63915-most-formula-one-pole-positions-in-career"
                    }
                }
            ]
        },
        {
            "id": "geography",
            "name": "Geography & Landmarks",
            "icon": "🗺️",
            "intro": "Ten stops on a world tour, with a good few stamps in the British passport along the way. Mountains, bridges, biomes, and the odd very tall building.",
            "questions": [
                {
                    "question": "The Burj Khalifa, opened in January 2010, is still the tallest building in the world. In which city does it stand?",
                    "answer": "Dubai",
                    "acceptable": [
                        "Dubai, UAE",
                        "Dubai, United Arab Emirates"
                    ],
                    "difficulty": "easy",
                    "topic": "World landmarks",
                    "funFact": "It was planned and built as the Burj Dubai, and only renamed Burj Khalifa on the day it was inaugurated.",
                    "source": {
                        "name": "Wikipedia - Burj Khalifa",
                        "url": "https://en.wikipedia.org/wiki/Burj_Khalifa"
                    }
                },
                {
                    "question": "The Inca citadel of Machu Picchu sits high in the Andes. Which South American country would you travel to in order to see it?",
                    "answer": "Peru",
                    "acceptable": [
                        "Republic of Peru"
                    ],
                    "difficulty": "easy",
                    "topic": "World landmarks",
                    "funFact": "It sits roughly 2,400 metres up a mountain ridge, about 80 kilometres north-west of the old Inca capital, Cusco.",
                    "source": {
                        "name": "Wikipedia - Machu Picchu",
                        "url": "https://en.wikipedia.org/wiki/Machu_Picchu"
                    }
                },
                {
                    "question": "Inaugurated in 2012 and standing just over 309 metres tall, which London skyscraper is the tallest building in the United Kingdom?",
                    "answer": "The Shard",
                    "acceptable": [
                        "Shard",
                        "The Shard London Bridge",
                        "Shard of Glass"
                    ],
                    "difficulty": "easy",
                    "topic": "UK landmarks",
                    "funFact": "Architect Renzo Piano first sketched it on a restaurant menu, imagining a shard of glass rising out of the Thames.",
                    "source": {
                        "name": "Wikipedia - The Shard",
                        "url": "https://en.wikipedia.org/wiki/The_Shard"
                    }
                },
                {
                    "question": "Which Roman emperor ordered the building of the 73-mile wall that runs across northern England, from Wallsend on the Tyne to Bowness-on-Solway?",
                    "answer": "Hadrian",
                    "acceptable": [
                        "Emperor Hadrian",
                        "Publius Aelius Hadrianus"
                    ],
                    "difficulty": "medium",
                    "topic": "Historical landmarks",
                    "funFact": "Despite what everyone assumes, the wall nowhere follows the modern border between England and Scotland.",
                    "source": {
                        "name": "Wikipedia - Hadrian's Wall",
                        "url": "https://en.wikipedia.org/wiki/Hadrian%27s_Wall"
                    }
                },
                {
                    "question": "Opened in March 2001 in a worked-out china clay pit in Cornwall, which visitor attraction is famous for its giant bubble-like Biomes?",
                    "answer": "The Eden Project",
                    "acceptable": [
                        "Eden Project",
                        "Eden"
                    ],
                    "difficulty": "medium",
                    "topic": "UK attractions",
                    "funFact": "The exhausted pit had no soil at all, so Eden's growing medium was manufactured from composted waste and mine spoil.",
                    "source": {
                        "name": "Eden Project - Our origins",
                        "url": "https://www.edenproject.com/mission/origins"
                    }
                },
                {
                    "question": "What is the highest mountain in the United Kingdom?",
                    "answer": "Ben Nevis",
                    "acceptable": [
                        "Ben Nevis, Scotland",
                        "The Ben"
                    ],
                    "difficulty": "medium",
                    "topic": "UK geography",
                    "funFact": "Its 1,345-metre summit is the collapsed dome of an ancient volcano, and the John Muir Trust has owned the south side since 2000.",
                    "source": {
                        "name": "Wikipedia - Ben Nevis",
                        "url": "https://en.wikipedia.org/wiki/Ben_Nevis"
                    }
                },
                {
                    "question": "Which road bridge over the Firth of Forth, carrying three towers and cables that cross over one another in mid-span, opened to traffic in August 2017?",
                    "answer": "Queensferry Crossing",
                    "acceptable": [
                        "The Queensferry Crossing",
                        "Forth Replacement Crossing",
                        "Queensferry Bridge"
                    ],
                    "difficulty": "medium",
                    "topic": "UK landmarks",
                    "funFact": "When it opened it was the world's longest three-tower cable-stayed bridge, and it is still the tallest bridge in the UK.",
                    "source": {
                        "name": "Transport Scotland - Forth Replacement Crossing",
                        "url": "https://www.transport.gov.scot/projects/forth-replacement-crossing/project-details/"
                    }
                },
                {
                    "question": "Which country has more UNESCO World Heritage Sites than any other?",
                    "answer": "Italy",
                    "acceptable": [
                        "Italia",
                        "Italian Republic"
                    ],
                    "difficulty": "medium",
                    "topic": "World Heritage",
                    "funFact": "Italy's tally of well over 60 includes Venice, Pompeii, the Dolomites and the historic centres of Rome and Florence, with China one behind.",
                    "source": {
                        "name": "Wikipedia - List of World Heritage Sites in Italy",
                        "url": "https://en.wikipedia.org/wiki/List_of_World_Heritage_Sites_in_Italy"
                    }
                },
                {
                    "question": "In October 2025, which still-unfinished basilica overtook Germany's Ulm Minster to become the tallest church in the world?",
                    "answer": "The Sagrada Familia",
                    "acceptable": [
                        "Sagrada Familia",
                        "La Sagrada Familia",
                        "Basilica de la Sagrada Familia",
                        "Basilica of the Holy Family",
                        "Gaudi's church in Barcelona"
                    ],
                    "difficulty": "hard",
                    "topic": "World landmarks",
                    "funFact": "Work began in 1882; the central tower reached its full 172.5 metres in February 2026, and was blessed by the Pope that June.",
                    "source": {
                        "name": "Wikipedia - Sagrada Familia",
                        "url": "https://en.wikipedia.org/wiki/Sagrada_Fam%C3%ADlia"
                    }
                },
                {
                    "question": "Which country, having declared independence from its northern neighbour in July 2011, is the newest member state of the United Nations?",
                    "answer": "South Sudan",
                    "acceptable": [
                        "Republic of South Sudan",
                        "Sudan, South"
                    ],
                    "difficulty": "hard",
                    "topic": "World geography",
                    "funFact": "It declared independence on 9 July 2011 and was admitted to the United Nations just five days later. Its capital is Juba.",
                    "source": {
                        "name": "United Nations - Member States",
                        "url": "https://www.un.org/en/about-us/member-states"
                    }
                }
            ]
        },
        {
            "id": "kids-expert",
            "name": "Ask the Eleven-Year-Old",
            "icon": "🎒",
            "intro": "This round belongs to the youngest person in the room. Every question comes from the world of a British eleven-year-old in 2026 — the games actually played at breaktime, the films on repeat, the toys, and the things drilled into you at school. Grown-ups, you are allowed to guess, and you are going to need to. No phones, and nobody is allowed to look at her face while she writes.",
            "questions": [
                {
                    "question": "Which Roblox game — where you buy seeds from the shop, plant them, wait for them to grow and then sell your crops — broke the Guinness World Records title in June 2025 for the most people playing one video game at the same time, with 21.6 million?",
                    "answer": "Grow a Garden",
                    "acceptable": [
                        "Grow a Garden",
                        "Grow-a-Garden",
                        "Grow Garden"
                    ],
                    "difficulty": "easy",
                    "topic": "Gaming",
                    "funFact": "Roblox says the platform itself has since passed 30 million players online at the same time.",
                    "source": {
                        "name": "Roblox Newsroom (official)",
                        "url": "https://about.roblox.com/newsroom/2025/06/roblox-infrastructure-supporting-record-breaking-games"
                    }
                },
                {
                    "question": "In the Netflix film KPop Demon Hunters, the girls' singing holds up a magical barrier that seals the demon world away from the human world. What is that barrier called?",
                    "answer": "The Honmoon",
                    "acceptable": [
                        "Honmoon",
                        "The Honmoon",
                        "Hon Moon",
                        "Honmun",
                        "Golden Honmoon"
                    ],
                    "difficulty": "easy",
                    "topic": "Film",
                    "funFact": "Rumi's dream is to turn it gold — but at the end the girls manage a rainbow one instead.",
                    "source": {
                        "name": "Netflix Tudum (official) — The Story Behind Every Color",
                        "url": "https://www.netflix.com/tudum/features/kpop-demon-hunters-colors"
                    }
                },
                {
                    "question": "In the Dog Man books and the 2025 DreamWorks film, Dog Man's arch-enemy is an evil cat who clones himself and accidentally creates a good kitten. What is the cat called?",
                    "answer": "Petey",
                    "acceptable": [
                        "Petey",
                        "Petey the Cat",
                        "Pete"
                    ],
                    "difficulty": "easy",
                    "topic": "Books and film",
                    "funFact": "Petey is voiced in the film by the American comedian Pete Davidson.",
                    "source": {
                        "name": "Universal Pictures (official film page)",
                        "url": "https://www.universalpicturesathome.com/movies/dog-man"
                    }
                },
                {
                    "question": "Which Roblox game, known to everyone who plays it as DTI, gives you a few minutes to put together an outfit for a set theme before you strut down the runway to show off your style?",
                    "answer": "Dress to Impress",
                    "acceptable": [
                        "Dress to Impress",
                        "DTI",
                        "Dress 2 Impress",
                        "Dress To Impress Roblox"
                    ],
                    "difficulty": "medium",
                    "topic": "Gaming",
                    "funFact": "Players vote for their favourite outfits, and you can strike poses on the runway to show yours off.",
                    "source": {
                        "name": "Roblox (official experience page)",
                        "url": "https://www.roblox.com/games/15101393044/Dress-To-Impress"
                    }
                },
                {
                    "question": "Which maths website, used in thousands of British schools, has you answering times tables against the clock, earning coins for a rock avatar and climbing from New Artist up to Rock Hero?",
                    "answer": "Times Tables Rock Stars",
                    "acceptable": [
                        "Times Tables Rock Stars",
                        "Times Table Rockstars",
                        "TT Rock Stars",
                        "TTRS"
                    ],
                    "difficulty": "medium",
                    "topic": "School life",
                    "funFact": "Its makers say it is used in more than 15,000 primary and secondary schools worldwide.",
                    "source": {
                        "name": "Times Tables Rock Stars (official site)",
                        "url": "https://ttrockstars.com/"
                    }
                },
                {
                    "question": "In the cartoon Bluey, dad Bandit spends most of his time playing games with Bluey and Bingo — but what is his actual job?",
                    "answer": "An archaeologist",
                    "acceptable": [
                        "Archaeologist",
                        "An archaeologist",
                        "Archeologist",
                        "He digs up bones"
                    ],
                    "difficulty": "medium",
                    "topic": "Television",
                    "funFact": "Bandit's most notorious alter ego is the cheeky puppet Unicorse. He is voiced by Dave McCormack.",
                    "source": {
                        "name": "Bluey official website (BBC Studios) — Bandit",
                        "url": "https://www.bluey.tv/characters/bandit/"
                    }
                },
                {
                    "question": "Minecraft's Chase the Skies game drop added a big, friendly, flying white mob that you and your friends can climb aboard and fly around on. What is it called?",
                    "answer": "The happy ghast",
                    "acceptable": [
                        "Happy ghast",
                        "Happy ghasts",
                        "The happy ghast"
                    ],
                    "difficulty": "medium",
                    "topic": "Gaming",
                    "funFact": "You raise it from a dried ghast block into a ghastling, then fit a dyeable ghast harness.",
                    "source": {
                        "name": "Minecraft.net (Mojang, official)",
                        "url": "https://www.minecraft.net/en-us/updates/introducing-chase-the-skies-drop"
                    }
                },
                {
                    "question": "British schoolchildren are drilled in starting a sentence with a phrase such as 'Later that day,' followed by a comma. What is the grammar term for that phrase?",
                    "answer": "A fronted adverbial",
                    "acceptable": [
                        "Fronted adverbial",
                        "Fronted adverbials",
                        "A fronted adverbial"
                    ],
                    "difficulty": "medium",
                    "topic": "School life",
                    "funFact": "The national curriculum's own example is 'Later that day, I heard the bad news.' It is taught in Year 4.",
                    "source": {
                        "name": "GOV.UK — National curriculum in England, English Appendix 2",
                        "url": "https://assets.publishing.service.gov.uk/government/uploads/system/uploads/attachment_data/file/335190/English_Appendix_2_-_Vocabulary_grammar_and_punctuation.pdf"
                    }
                },
                {
                    "question": "Labubu, the grinning, fanged little creature sold in blind boxes by Pop Mart, belongs to a whole family of elf characters. What is that family called?",
                    "answer": "The Monsters",
                    "acceptable": [
                        "The Monsters",
                        "Monsters"
                    ],
                    "difficulty": "hard",
                    "topic": "Toys and collectables",
                    "funFact": "Pop Mart says they live it up in the great Nordic forest, enjoying life to the fullest.",
                    "source": {
                        "name": "POP MART (official store) — The Monsters",
                        "url": "https://www.popmart.com/us/collection/11/the-monsters"
                    }
                },
                {
                    "question": "In Pokémon Legends: Z-A, the whole story happens inside Lumiose City, and every night battle zones appear in the streets for a fierce competition. What is that competition called?",
                    "answer": "The Z-A Royale",
                    "acceptable": [
                        "Z-A Royale",
                        "The Z-A Royale",
                        "ZA Royale",
                        "Z A Royale"
                    ],
                    "difficulty": "hard",
                    "topic": "Gaming",
                    "funFact": "Trainers start at Rank Z; anyone reaching Rank A is offered the chance to have one wish granted.",
                    "source": {
                        "name": "The Pokémon Company — Pokémon Legends: Z-A official site (UK)",
                        "url": "https://legends.pokemon.com/en-gb/gameplay/"
                    }
                }
            ]
        },
        {
            "id": "disney",
            "name": "The Mouse House",
            "icon": "🏰",
            "intro": "Right — everyone in this room has sung along to at least one of these, whether you admit it or not. We're going from Walt's very first feature all the way up to the recent Pixar films, so no excuses from anybody.",
            "questions": [
                {
                    "question": "In Disney's Frozen, Elsa is the one with the ice powers. What is the name of her younger sister?",
                    "answer": "Anna",
                    "acceptable": [
                        "Princess Anna",
                        "Anna of Arendelle"
                    ],
                    "difficulty": "easy",
                    "topic": "Frozen (2013) — characters",
                    "funFact": "Arendelle was based on Norway, with several locations drawing on real landmarks including Oslo's Akershus Fortress.",
                    "source": {
                        "name": "Wikipedia — Frozen (2013 film)",
                        "url": "https://en.wikipedia.org/wiki/Frozen_(2013_film)"
                    }
                },
                {
                    "question": "In Toy Story 4, Bonnie makes a brand new toy out of a plastic spork at her school orientation day. What does she call him?",
                    "answer": "Forky",
                    "acceptable": [
                        "Forky the spork",
                        "Forkie"
                    ],
                    "difficulty": "easy",
                    "topic": "Pixar — Toy Story 4 (2019)",
                    "funFact": "Forky spends the whole film insisting he is rubbish rather than a toy, and keeps throwing himself in the bin.",
                    "source": {
                        "name": "Wikipedia — Toy Story 4",
                        "url": "https://en.wikipedia.org/wiki/Toy_Story_4"
                    }
                },
                {
                    "question": "In Disney's 1940 classic, which wooden puppet finds his nose growing longer every time he tells a lie?",
                    "answer": "Pinocchio",
                    "acceptable": [
                        "Pinocchio the puppet",
                        "Pinnochio"
                    ],
                    "difficulty": "easy",
                    "topic": "Classic Disney — Pinocchio (1940)",
                    "funFact": "The woodcarver Geppetto wishes his puppet were a real boy, and a fairy brings the little wooden lad to life.",
                    "source": {
                        "name": "Encyclopaedia Britannica — Pinocchio (1940 film)",
                        "url": "https://www.britannica.com/topic/Pinocchio-film-1940"
                    }
                },
                {
                    "question": "In Moana, which shape-shifting demigod, voiced by Dwayne Johnson, sets off on the voyage with her?",
                    "answer": "Maui",
                    "acceptable": [
                        "Maui the demigod"
                    ],
                    "difficulty": "medium",
                    "topic": "Moana (2016) — characters",
                    "funFact": "Moana's songs were co-written by Hamilton creator Lin-Manuel Miranda, alongside Opetaia Foa'i and Mark Mancina.",
                    "source": {
                        "name": "Wikipedia — Moana (2016 film)",
                        "url": "https://en.wikipedia.org/wiki/Moana_(2016_film)"
                    }
                },
                {
                    "question": "In 2012 Disney paid just over four billion dollars to buy the studio behind Star Wars. Which company was it?",
                    "answer": "Lucasfilm",
                    "acceptable": [
                        "Lucasfilm Ltd",
                        "Lucas Film",
                        "George Lucas's company"
                    ],
                    "difficulty": "medium",
                    "topic": "Disney history — studio takeovers",
                    "funFact": "Disney announced the 4.05 billion dollar deal in October 2012 and completed it that December, making Lucasfilm a wholly owned subsidiary.",
                    "source": {
                        "name": "Wikipedia — Lucasfilm",
                        "url": "https://en.wikipedia.org/wiki/Lucasfilm"
                    }
                },
                {
                    "question": "Which 1937 Disney film was the first full-length cel-animated feature in cinema history?",
                    "answer": "Snow White and the Seven Dwarfs",
                    "acceptable": [
                        "Snow White",
                        "Snow White and the 7 Dwarfs"
                    ],
                    "difficulty": "medium",
                    "topic": "Classic Disney — Snow White (1937)",
                    "funFact": "Insiders derisively called it \"Disney's Folly\"; the estimated $250,000 budget ended up near $1.5 million, and Walt mortgaged his house.",
                    "source": {
                        "name": "BFI — The story of Disney in 11 films",
                        "url": "https://www.bfi.org.uk/lists/story-disney-11-films-milestone-decade"
                    }
                },
                {
                    "question": "Who played Ariel in Disney's 2023 live-action remake of The Little Mermaid?",
                    "answer": "Halle Bailey",
                    "acceptable": [
                        "Bailey",
                        "Hallie Bailey"
                    ],
                    "difficulty": "medium",
                    "topic": "Live-action remakes — The Little Mermaid (2023)",
                    "funFact": "It remakes Disney's 1989 animated version, itself loosely based on Hans Christian Andersen's fairy tale of 1837.",
                    "source": {
                        "name": "Wikipedia — The Little Mermaid (2023 film)",
                        "url": "https://en.wikipedia.org/wiki/The_Little_Mermaid_(2023_film)"
                    }
                },
                {
                    "question": "Disney's sixth resort worldwide, and its first on the Chinese mainland, opened in June 2016. In which city?",
                    "answer": "Shanghai",
                    "acceptable": [
                        "Shanghai Disney Resort",
                        "Shanghai Disneyland"
                    ],
                    "difficulty": "medium",
                    "topic": "Disney parks",
                    "funFact": "It sits in the Pudong district, following the parks in California, Florida, Tokyo, Paris and Hong Kong.",
                    "source": {
                        "name": "Wikipedia — Shanghai Disney Resort",
                        "url": "https://en.wikipedia.org/wiki/Shanghai_Disney_Resort"
                    }
                },
                {
                    "question": "Walt Disney very nearly gave his most famous character a completely different name. What did he originally want to call Mickey Mouse?",
                    "answer": "Mortimer",
                    "acceptable": [
                        "Mortimer Mouse"
                    ],
                    "difficulty": "hard",
                    "topic": "Disney history — Mickey Mouse",
                    "funFact": "It was Walt's wife Lillian who disliked Mortimer and suggested Mickey instead.",
                    "source": {
                        "name": "Encyclopaedia Britannica — Mickey Mouse",
                        "url": "https://www.britannica.com/topic/Mickey-Mouse"
                    }
                },
                {
                    "question": "Which film was the first Pixar film ever to win the Academy Award for Best Animated Feature?",
                    "answer": "Finding Nemo",
                    "acceptable": [
                        "Nemo"
                    ],
                    "difficulty": "hard",
                    "topic": "Pixar — awards",
                    "funFact": "It beat Brother Bear and The Triplets of Belleville in 2004; Shrek had won the very first award.",
                    "source": {
                        "name": "Wikipedia — Finding Nemo",
                        "url": "https://en.wikipedia.org/wiki/Finding_Nemo"
                    }
                }
            ]
        },
        {
            "id": "logic",
            "name": "Logic & Lateral Thinking",
            "icon": "🧩",
            "intro": "This round contains no general knowledge whatsoever — nothing to remember, only things to work out. Every fact you need is inside the question. Everyone starts level here, and the youngest brain in the room is very often the quickest.",
            "questions": [
                {
                    "question": "Here is a sequence of letters: J, F, M, A, M, J, J, A, S, O, N. What single letter comes next?",
                    "answer": "D",
                    "acceptable": [
                        "D",
                        "D for December",
                        "December"
                    ],
                    "difficulty": "easy",
                    "topic": "Letter sequences",
                    "funFact": "Its name comes from the Latin decem, ten — December was the tenth month of the old Roman calendar, which began in March.",
                    "source": {
                        "name": "Wikipedia — December",
                        "url": "https://en.wikipedia.org/wiki/December"
                    }
                },
                {
                    "question": "A drawer holds a jumbled mixture of black socks and blue socks, and the light is off so you cannot see the colours. What is the smallest number of socks you must take out to be certain you have a matching pair?",
                    "answer": "3",
                    "acceptable": [
                        "3",
                        "three",
                        "3 socks",
                        "three socks"
                    ],
                    "difficulty": "easy",
                    "topic": "Logic puzzles",
                    "funFact": "This is the pigeonhole principle. With only two colours going in, three socks coming out must include two of a kind.",
                    "source": {
                        "name": "Wikipedia — Pigeonhole principle",
                        "url": "https://en.wikipedia.org/wiki/Pigeonhole_principle"
                    }
                },
                {
                    "question": "What number comes next in this sequence: 1, 1, 2, 3, 5, 8, 13?",
                    "answer": "21",
                    "acceptable": [
                        "21",
                        "twenty-one",
                        "twenty one"
                    ],
                    "difficulty": "easy",
                    "topic": "Number sequences",
                    "funFact": "It's the Fibonacci sequence, and the same pattern shows up in pine cones, sunflower heads and pineapple skins.",
                    "source": {
                        "name": "Wikipedia — Fibonacci sequence",
                        "url": "https://en.wikipedia.org/wiki/Fibonacci_sequence"
                    }
                },
                {
                    "question": "A farmer must cross a river with a wolf, a goat and a cabbage. His boat carries only him and one of the three. Left alone together the wolf eats the goat, and the goat eats the cabbage. Which one must he take across first?",
                    "answer": "The goat",
                    "acceptable": [
                        "goat",
                        "the goat",
                        "he takes the goat"
                    ],
                    "difficulty": "medium",
                    "topic": "Logic puzzles",
                    "funFact": "This puzzle is over a thousand years old, appearing in a medieval problem collection credited to Alcuin of York.",
                    "source": {
                        "name": "Wikipedia — Wolf, goat and cabbage problem",
                        "url": "https://en.wikipedia.org/wiki/Wolf,_goat_and_cabbage_problem"
                    }
                },
                {
                    "question": "Ten people are at a party, and every single person shakes hands exactly once with every other person there. How many handshakes take place altogether?",
                    "answer": "45",
                    "acceptable": [
                        "45",
                        "forty-five",
                        "forty five",
                        "45 handshakes"
                    ],
                    "difficulty": "medium",
                    "topic": "Counting puzzles",
                    "funFact": "The answer is a triangular number: nine plus eight plus seven, all the way down to one, comes to forty-five.",
                    "source": {
                        "name": "Wikipedia — Triangular number",
                        "url": "https://en.wikipedia.org/wiki/Triangular_number"
                    }
                },
                {
                    "question": "A patch of lily pads on a lake doubles in size every day. It takes 48 days to cover the whole lake. How many days does it take to cover half the lake?",
                    "answer": "47 days",
                    "acceptable": [
                        "47",
                        "47 days",
                        "forty-seven",
                        "forty-seven days"
                    ],
                    "difficulty": "medium",
                    "topic": "Lateral thinking",
                    "funFact": "It comes from the Cognitive Reflection Test of 2005, and the gut answer people blurt out is 24 days.",
                    "source": {
                        "name": "Wikipedia — Cognitive reflection test",
                        "url": "https://en.wikipedia.org/wiki/Cognitive_reflection_test"
                    }
                },
                {
                    "question": "In the Tower of Hanoi puzzle you shift a stack of discs between three pegs, moving one disc at a time, and you may never put a larger disc on top of a smaller one. What is the fewest number of moves needed to shift a stack of three discs onto another peg?",
                    "answer": "7 moves",
                    "acceptable": [
                        "7",
                        "seven",
                        "7 moves",
                        "seven moves"
                    ],
                    "difficulty": "medium",
                    "topic": "Logic puzzles",
                    "funFact": "The rule is two to the power of the number of discs, minus one, so ten discs would need 1,023 moves.",
                    "source": {
                        "name": "Wikipedia — Tower of Hanoi",
                        "url": "https://en.wikipedia.org/wiki/Tower_of_Hanoi"
                    }
                },
                {
                    "question": "On a game show there are three doors: a car behind one and a goat behind each of the other two. You pick a door. The host, who knows where the car is, always opens one of the other two doors to reveal a goat, then offers you the chance to switch. If you always switch, what is your chance of winning the car?",
                    "answer": "2 in 3",
                    "acceptable": [
                        "2/3",
                        "two thirds",
                        "2 in 3",
                        "two in three",
                        "67%",
                        "66.7%",
                        "about 67 per cent"
                    ],
                    "difficulty": "medium",
                    "topic": "Probability puzzles",
                    "funFact": "When this answer was printed in a magazine, around 10,000 readers wrote in to object, nearly 1,000 of them with doctorates.",
                    "source": {
                        "name": "Wikipedia — Monty Hall problem",
                        "url": "https://en.wikipedia.org/wiki/Monty_Hall_problem"
                    }
                },
                {
                    "question": "Four walkers must cross a narrow bridge at night. They have one torch, the bridge holds only two people at a time, and the torch must be carried across and back every trip. On their own they cross in one minute, two minutes, five minutes and eight minutes, and a pair moves at the slower one's pace. What is the shortest possible time for all four to get across?",
                    "answer": "15 minutes",
                    "acceptable": [
                        "15",
                        "fifteen",
                        "15 minutes",
                        "fifteen minutes"
                    ],
                    "difficulty": "hard",
                    "topic": "Logic puzzles",
                    "funFact": "Most people find 17 minutes and stop. The trick is sending the two slowest across together instead of escorting them one by one.",
                    "source": {
                        "name": "Wikipedia — Bridge and torch problem",
                        "url": "https://en.wikipedia.org/wiki/Bridge_and_torch_problem"
                    }
                },
                {
                    "question": "How many squares of any size can be counted on a standard chessboard? Not just the 64 small ones, but every square from one-by-one right up to the whole eight-by-eight board.",
                    "answer": "204",
                    "acceptable": [
                        "204",
                        "two hundred and four",
                        "two hundred four"
                    ],
                    "difficulty": "hard",
                    "topic": "Counting puzzles",
                    "funFact": "It is the square numbers added up: 64 plus 49 plus 36, all the way down to one.",
                    "source": {
                        "name": "Wikipedia — Square pyramidal number",
                        "url": "https://en.wikipedia.org/wiki/Square_pyramidal_number"
                    }
                }
            ]
        },
        {
            "id": "general-knowledge",
            "name": "General Knowledge",
            "icon": "🧠",
            "intro": "Ten questions from all over the place — a bit of film, the biggest planet going, some money, some politics, a walk round the garden and one trip to Rome. They start gentle and get meaner as we go, so nobody should be staring at a blank sheet after question one. Pens down, no phones, and yes, the last two are supposed to be hard.",
            "questions": [
                {
                    "question": "In Disney's 2013 film Frozen, what is the name of the snowman who joins Anna and Kristoff on their journey?",
                    "answer": "Olaf",
                    "acceptable": [
                        "Olaf",
                        "Olaf the snowman"
                    ],
                    "difficulty": "easy",
                    "topic": "Film",
                    "funFact": "Frozen won two Oscars, including Best Original Song for \"Let It Go\".",
                    "source": {
                        "name": "Walt Disney Animation Studios",
                        "url": "https://disneyanimation.com/films/frozen/"
                    }
                },
                {
                    "question": "Which is the largest planet in our solar system?",
                    "answer": "Jupiter",
                    "acceptable": [
                        "Jupiter"
                    ],
                    "difficulty": "easy",
                    "topic": "Science",
                    "funFact": "Jupiter is so vast that if it were a hollow shell, around 1,000 Earths would fit inside.",
                    "source": {
                        "name": "NASA Science",
                        "url": "https://science.nasa.gov/jupiter/"
                    }
                },
                {
                    "question": "Whose portrait started appearing on Bank of England banknotes for the very first time in June 2024?",
                    "answer": "King Charles III",
                    "acceptable": [
                        "King Charles III",
                        "King Charles",
                        "Charles III",
                        "Charles",
                        "The King"
                    ],
                    "difficulty": "easy",
                    "topic": "Money and monarchy",
                    "funFact": "The King's portrait went onto all four notes — £5, £10, £20 and £50 — with no other design changes.",
                    "source": {
                        "name": "Bank of England",
                        "url": "https://www.bankofengland.co.uk/news/2024/june/king-charles-banknotes-enter-circulation-on-5-june-2024"
                    }
                },
                {
                    "question": "Who painted the ceiling of the Sistine Chapel in Rome?",
                    "answer": "Michelangelo",
                    "acceptable": [
                        "Michelangelo",
                        "Michelangelo Buonarroti",
                        "Buonarroti"
                    ],
                    "difficulty": "medium",
                    "topic": "Art",
                    "funFact": "The ceiling was finished by 31 October 1512 — the Pope said Mass beneath it the very next day.",
                    "source": {
                        "name": "Vatican Museums",
                        "url": "https://www.museivaticani.va/content/museivaticani/en/collezioni/musei/cappella-sistina/volta.html"
                    }
                },
                {
                    "question": "Which two-word term, meaning the mush your mind turns to from too much trivial online content, was named Oxford Word of the Year for 2024?",
                    "answer": "Brain rot",
                    "acceptable": [
                        "Brain rot",
                        "Brainrot",
                        "Brain-rot"
                    ],
                    "difficulty": "medium",
                    "topic": "Language",
                    "funFact": "It beat \"romantasy\" and \"slop\" in a public vote of more than 37,000 people.",
                    "source": {
                        "name": "Oxford University Press",
                        "url": "https://corp.oup.com/news/brain-rot-named-oxford-word-of-the-year-2024/"
                    }
                },
                {
                    "question": "From which English port did the Titanic set sail on her maiden voyage in April 1912?",
                    "answer": "Southampton",
                    "acceptable": [
                        "Southampton",
                        "Port of Southampton",
                        "Southampton docks"
                    ],
                    "difficulty": "medium",
                    "topic": "History",
                    "funFact": "She left at 12.15pm bound for New York; around 1,500 people died five days later.",
                    "source": {
                        "name": "Royal Museums Greenwich",
                        "url": "https://www.rmg.co.uk/collections/research-guides/research-guide-d1-rms-titanic-fact-sheet"
                    }
                },
                {
                    "question": "England's Lionesses retained their European title in July 2025 by beating which country on penalties in the final?",
                    "answer": "Spain",
                    "acceptable": [
                        "Spain",
                        "the Spanish",
                        "España"
                    ],
                    "difficulty": "medium",
                    "topic": "Sport",
                    "funFact": "Chloe Kelly buried the winning penalty after a 1-1 draw; England won the shootout 3-1.",
                    "source": {
                        "name": "England Football (The FA)",
                        "url": "https://www.englandfootball.com/england/womens-senior-team/fixtures-results/2024-25/EURO-2025/England-v-Spain-UEFA-Womens-EURO-final-sunday-27-July-2025"
                    }
                },
                {
                    "question": "Who became the first woman to be Chancellor of the Exchequer, taking the job in July 2024?",
                    "answer": "Rachel Reeves",
                    "acceptable": [
                        "Rachel Reeves",
                        "Reeves"
                    ],
                    "difficulty": "medium",
                    "topic": "Politics",
                    "funFact": "Before entering politics she worked as an economist at the Bank of England.",
                    "source": {
                        "name": "GOV.UK",
                        "url": "https://www.gov.uk/government/news/breaking-glass-ceilings-read-jessikah-sabrina-clare-and-the-chancellor-of-the-exchequers-stories"
                    }
                },
                {
                    "question": "Which bird took the top spot once again in the RSPB's Big Garden Birdwatch in 2026, as the most commonly counted garden bird in the UK?",
                    "answer": "House sparrow",
                    "acceptable": [
                        "House sparrow",
                        "Sparrow",
                        "House sparrows",
                        "Sparrows"
                    ],
                    "difficulty": "hard",
                    "topic": "Nature",
                    "funFact": "More than 650,000 people took part, counting over nine million birds across some 80 species.",
                    "source": {
                        "name": "RSPB",
                        "url": "https://www.rspb.org.uk/whats-happening/news/the-big-garden-birdwatch-twentysix-results-are-in"
                    }
                },
                {
                    "question": "The 2024 Nobel Peace Prize went to a Japanese organisation of Hiroshima and Nagasaki atomic bomb survivors. By what two-word Japanese name is it known?",
                    "answer": "Nihon Hidankyo",
                    "acceptable": [
                        "Nihon Hidankyo",
                        "Nihon Hidankyō",
                        "Hidankyo",
                        "Hidankyō",
                        "Japan Confederation of A- and H-Bomb Sufferers Organisations",
                        "Japan Confederation of A- and H-Bomb Sufferers Organizations"
                    ],
                    "difficulty": "hard",
                    "topic": "Current affairs",
                    "funFact": "Its members, the hibakusha, have given thousands of witness accounts to keep nuclear weapons taboo.",
                    "source": {
                        "name": "The Nobel Prize",
                        "url": "https://www.nobelprize.org/prizes/peace/2024/press-release/"
                    }
                }
            ]
        },
        {
            "id": "cars-b",
            "name": "Name That Modern Car",
            "icon": "🚙",
            "intro": "Ten cars, and most of them you could meet on the school run tomorrow. Two or three you will only meet in your dreams. Make and model please, though the model on its own will do. Badges and number plates have been smudged out, so no peeking.",
            "questions": [
                {
                    "question": "Name this car.",
                    "answer": "Tesla Model 3",
                    "acceptable": [
                        "Model 3",
                        "Tesla 3",
                        "Model Three",
                        "Tesla Model Three"
                    ],
                    "difficulty": "easy",
                    "topic": "Cars",
                    "funFact": "In June 2021 it became the first electric car ever to pass a million global sales.",
                    "image": {
                        "src": "images/cars-b/car-b-01.jpg",
                        "alt": "A modern car photographed from the side",
                        "fit": "cover",
                        "credit": "Jengtingchen",
                        "license": "CC BY-SA 4.0",
                        "licenseUrl": "https://creativecommons.org/licenses/by-sa/4.0",
                        "sourceUrl": "https://commons.wikimedia.org/wiki/File:Tesla_Model_3_2021_facelift.jpg",
                        "trademark": false
                    },
                    "source": {
                        "name": "Wikipedia — Tesla Model 3",
                        "url": "https://en.wikipedia.org/wiki/Tesla_Model_3"
                    }
                },
                {
                    "question": "Name this car.",
                    "answer": "Mini Cooper",
                    "acceptable": [
                        "Mini",
                        "Mini Hatch",
                        "Mini Cooper S",
                        "Mini One",
                        "BMW Mini",
                        "Mini hatchback",
                        "Mini 3-door"
                    ],
                    "difficulty": "easy",
                    "topic": "Cars",
                    "funFact": "BMW has been building this one at Plant Oxford, in Cowley, since May 2001.",
                    "image": {
                        "src": "images/cars-b/car-b-02.jpg",
                        "alt": "A modern car on a British street",
                        "fit": "cover",
                        "credit": "Calreyn88 (badge blurred)",
                        "license": "CC BY-SA 4.0",
                        "licenseUrl": "https://creativecommons.org/licenses/by-sa/4.0",
                        "sourceUrl": "https://commons.wikimedia.org/wiki/File:2019_Mini_Cooper_Sport_Auto.jpg",
                        "trademark": false
                    },
                    "source": {
                        "name": "Wikipedia — Plant Oxford",
                        "url": "https://en.wikipedia.org/wiki/Plant_Oxford"
                    }
                },
                {
                    "question": "Name this car.",
                    "answer": "Land Rover Defender",
                    "acceptable": [
                        "Defender",
                        "Land Rover Defender 110",
                        "Defender 110",
                        "New Defender",
                        "Landrover Defender"
                    ],
                    "difficulty": "easy",
                    "topic": "Cars",
                    "funFact": "For all the very British name, these are built at Jaguar Land Rover's plant in Nitra, Slovakia.",
                    "image": {
                        "src": "images/cars-b/car-b-03.jpg",
                        "alt": "A modern car photographed from the side",
                        "fit": "cover",
                        "credit": "Vauxford (badge blurred)",
                        "license": "CC BY-SA 4.0",
                        "licenseUrl": "https://creativecommons.org/licenses/by-sa/4.0",
                        "sourceUrl": "https://commons.wikimedia.org/wiki/File:2020_Land_Rover_Defender_SE_Diesel_Automatic_2.0_Side.jpg",
                        "trademark": false
                    },
                    "source": {
                        "name": "Wikipedia — Land Rover Defender (L663)",
                        "url": "https://en.wikipedia.org/wiki/Land_Rover_Defender_(L663)"
                    }
                },
                {
                    "question": "Name this car.",
                    "answer": "Nissan Qashqai",
                    "acceptable": [
                        "Qashqai",
                        "Cashcai",
                        "Kashkai",
                        "Nissan Cashcai"
                    ],
                    "difficulty": "medium",
                    "topic": "Cars",
                    "funFact": "It has been built in Sunderland since December 2006, which makes it about as British as cars get.",
                    "image": {
                        "src": "images/cars-b/car-b-04.jpg",
                        "alt": "A modern car parked on a street",
                        "fit": "cover",
                        "credit": "Damian B Oh (badge blurred)",
                        "license": "CC BY-SA 4.0",
                        "licenseUrl": "https://creativecommons.org/licenses/by-sa/4.0",
                        "sourceUrl": "https://commons.wikimedia.org/wiki/File:Nissan_QashqaiJ12_Gun_Metallic_(2).jpg",
                        "trademark": false
                    },
                    "source": {
                        "name": "Wikipedia — Nissan Qashqai",
                        "url": "https://en.wikipedia.org/wiki/Nissan_Qashqai"
                    }
                },
                {
                    "question": "Name this car.",
                    "answer": "Volkswagen ID. Buzz",
                    "acceptable": [
                        "ID Buzz",
                        "ID. Buzz",
                        "VW ID Buzz",
                        "VW Buzz",
                        "Volkswagen Buzz",
                        "Buzz",
                        "ID-Buzz"
                    ],
                    "difficulty": "medium",
                    "topic": "Cars",
                    "funFact": "Volkswagen calls it a Bulli for the electric age, and builds it at its Hanover plant.",
                    "image": {
                        "src": "images/cars-b/car-b-05.jpg",
                        "alt": "A modern car on a city street",
                        "fit": "cover",
                        "credit": "Wikisympathisant (badge and plate blurred)",
                        "license": "CC BY-SA 4.0",
                        "licenseUrl": "https://creativecommons.org/licenses/by-sa/4.0",
                        "sourceUrl": "https://commons.wikimedia.org/wiki/File:2022-08_ID.Buzz_Kopenhagen_crop.jpg",
                        "trademark": false
                    },
                    "source": {
                        "name": "Volkswagen Newsroom",
                        "url": "https://www.volkswagen-newsroom.com/en/press-releases/a-bulli-for-the-all-electric-future-world-premiere-of-the-new-id-buzz-7800"
                    }
                },
                {
                    "question": "Name this car.",
                    "answer": "Suzuki Jimny",
                    "acceptable": [
                        "Jimny",
                        "Jimni",
                        "Suzuki Jimni"
                    ],
                    "difficulty": "medium",
                    "topic": "Cars",
                    "funFact": "Suzuki has sold small four-wheel drives under this name since 1970, starting in Japan's tiny kei class.",
                    "image": {
                        "src": "images/cars-b/car-b-06.jpg",
                        "alt": "A modern car parked on a British street",
                        "fit": "cover",
                        "credit": "Vauxford (cropped)",
                        "license": "CC BY-SA 4.0",
                        "licenseUrl": "https://creativecommons.org/licenses/by-sa/4.0",
                        "sourceUrl": "https://commons.wikimedia.org/wiki/File:2019_Suzuki_Jimny_SZ5_4X4_Automatic_1.5_(1).jpg",
                        "trademark": false
                    },
                    "source": {
                        "name": "Wikipedia — Suzuki Jimny",
                        "url": "https://en.wikipedia.org/wiki/Suzuki_Jimny"
                    }
                },
                {
                    "question": "Name this car.",
                    "answer": "Hyundai Ioniq 5",
                    "acceptable": [
                        "Ioniq 5",
                        "Ioniq Five",
                        "Hyundai Ioniq Five",
                        "Ionic 5",
                        "Ioniq5"
                    ],
                    "difficulty": "medium",
                    "topic": "Cars",
                    "funFact": "It swept the 2022 World Car Awards: car of the year, electric vehicle and design.",
                    "image": {
                        "src": "images/cars-b/car-b-07.jpg",
                        "alt": "A modern car in a British car park",
                        "fit": "cover",
                        "credit": "Andrew Bone",
                        "license": "CC BY 2.0",
                        "licenseUrl": "https://creativecommons.org/licenses/by/2.0",
                        "sourceUrl": "https://commons.wikimedia.org/wiki/File:Hyundai_Ioniq_5_(2021,_Weymouth,_UK_-_side_%26_front).jpg",
                        "trademark": false
                    },
                    "source": {
                        "name": "Hyundai Motor Europe newsroom",
                        "url": "https://www.hyundai.news/eu/articles/press-releases/hyundai-ioniq-5-triple-win-at-world-car-awards-2022.html"
                    }
                },
                {
                    "question": "Name this car.",
                    "answer": "Porsche 911",
                    "acceptable": [
                        "911",
                        "Nine Eleven",
                        "Porsche Nine Eleven",
                        "Porsche Carrera",
                        "Porsche 911 Carrera",
                        "992"
                    ],
                    "difficulty": "medium",
                    "topic": "Cars",
                    "funFact": "It was going to be the 901, until Peugeot objected to three-digit names with a zero in the middle.",
                    "image": {
                        "src": "images/cars-b/car-b-08.jpg",
                        "alt": "A modern car parked in a car park",
                        "fit": "cover",
                        "credit": "Alexander Migl (plate blurred)",
                        "license": "CC BY-SA 4.0",
                        "licenseUrl": "https://creativecommons.org/licenses/by-sa/4.0",
                        "sourceUrl": "https://commons.wikimedia.org/wiki/File:Porsche_992_Carrera_S_coupe_IMG_5838.jpg",
                        "trademark": false
                    },
                    "source": {
                        "name": "Porsche Newsroom",
                        "url": "https://newsroom.porsche.com/en/history/porsche-history-901-911-iaa-12274.html"
                    }
                },
                {
                    "question": "Name this car.",
                    "answer": "Rolls-Royce Cullinan",
                    "acceptable": [
                        "Cullinan",
                        "Rolls Royce Cullinan",
                        "RR Cullinan",
                        "Rolls-Royce Cullinan Series II"
                    ],
                    "difficulty": "hard",
                    "topic": "Cars",
                    "funFact": "It is named after the largest gem-quality rough diamond ever discovered.",
                    "image": {
                        "src": "images/cars-b/car-b-09.jpg",
                        "alt": "A modern car seen from above",
                        "fit": "cover",
                        "credit": "OWS Photography (cropped)",
                        "license": "CC BY 4.0",
                        "licenseUrl": "https://creativecommons.org/licenses/by/4.0",
                        "sourceUrl": "https://commons.wikimedia.org/wiki/File:Rolls_Royce_Cullinan_Washington_DC_Metro_Area,_USA.jpg",
                        "trademark": false
                    },
                    "source": {
                        "name": "Wikipedia — Rolls-Royce Cullinan",
                        "url": "https://en.wikipedia.org/wiki/Rolls-Royce_Cullinan"
                    }
                },
                {
                    "question": "Name this car.",
                    "answer": "Bugatti Chiron",
                    "acceptable": [
                        "Chiron",
                        "Bugatti Chiron Sport",
                        "Bugatti Chiron Super Sport",
                        "Sheeron"
                    ],
                    "difficulty": "hard",
                    "topic": "Cars",
                    "funFact": "Production was capped at five hundred cars, and the very last one was finished in 2024.",
                    "image": {
                        "src": "images/cars-b/car-b-10.jpg",
                        "alt": "A modern car parked outside a grand building",
                        "fit": "cover",
                        "credit": "Alexandre Prevot (badge blurred)",
                        "license": "CC BY-SA 2.0",
                        "licenseUrl": "https://creativecommons.org/licenses/by-sa/2.0",
                        "sourceUrl": "https://commons.wikimedia.org/wiki/File:Bugatti_Chiron_(50176389122)_(cropped).jpg",
                        "trademark": false
                    },
                    "source": {
                        "name": "Wikipedia — Bugatti Chiron",
                        "url": "https://en.wikipedia.org/wiki/Bugatti_Chiron"
                    }
                }
            ]
        },
        {
            "id": "cocktails",
            "name": "Shaken and Stirred",
            "icon": "🍸",
            "intro": "Ten on cocktails — but mostly the bits you can see from the outside: the garnishes, the rims, the mixers, the emoji and the names. No tasting required, and there is plenty in here for the youngest at the table.",
            "questions": [
                {
                    "question": "The official garnish for a Bloody Mary is a stick of which crunchy green salad vegetable, served alongside an optional lemon wedge?",
                    "answer": "Celery",
                    "acceptable": [
                        "Celery stick",
                        "A stick of celery",
                        "Celery stalk"
                    ],
                    "difficulty": "easy",
                    "topic": "Garnishes",
                    "funFact": "The alcohol-free version of the very same drink goes by the name Virgin Mary.",
                    "source": {
                        "name": "International Bartenders Association (IBA) — Bloody Mary",
                        "url": "https://iba-world.com/iba-cocktail/bloody-mary/"
                    }
                },
                {
                    "question": "The rim of a Margarita glass is traditionally coated with which everyday kitchen seasoning?",
                    "answer": "Salt",
                    "acceptable": [
                        "Table salt",
                        "A salt rim",
                        "Sea salt",
                        "Salted rim"
                    ],
                    "difficulty": "easy",
                    "topic": "Glassware and rims",
                    "funFact": "The official spec asks for only half the rim to be salted, so the drinker can choose salt or no salt.",
                    "source": {
                        "name": "International Bartenders Association (IBA) — Margarita",
                        "url": "https://iba-world.com/iba-cocktail/margarita/"
                    }
                },
                {
                    "question": "The official garnish floated on top of an Espresso Martini is how many coffee beans?",
                    "answer": "Three",
                    "acceptable": [
                        "3",
                        "Three coffee beans",
                        "3 beans",
                        "3 coffee beans"
                    ],
                    "difficulty": "easy",
                    "topic": "Modern classics",
                    "funFact": "London bartender Dick Bradsell created the drink in the 1980s, for a customer who wanted something to wake her up.",
                    "source": {
                        "name": "International Bartenders Association (IBA) — Espresso Martini",
                        "url": "https://iba-world.com/iba-cocktail/espresso-martini/"
                    }
                },
                {
                    "question": "Which bright orange Italian aperitif is mixed with prosecco and a splash of soda water to make a Spritz?",
                    "answer": "Aperol",
                    "acceptable": [
                        "Aperol liqueur",
                        "Aperol Spritz"
                    ],
                    "difficulty": "medium",
                    "topic": "Aperitifs",
                    "funFact": "The official recipe uses more prosecco than Aperol — 90ml to 60ml — then just a splash of soda water.",
                    "source": {
                        "name": "International Bartenders Association (IBA) — Spritz",
                        "url": "https://iba-world.com/iba-cocktail/spritz/"
                    }
                },
                {
                    "question": "In the official Unicode list, the 🍹 emoji — a tall glass with fruit and a little paper umbrella — goes by what two-word name?",
                    "answer": "Tropical Drink",
                    "acceptable": [
                        "Tropical drink emoji",
                        "A tropical drink"
                    ],
                    "difficulty": "medium",
                    "topic": "Emoji",
                    "funFact": "Its neighbour 🍸 is officially the cocktail glass emoji, and both were added to Unicode back in 2010.",
                    "source": {
                        "name": "Unicode Character Properties — U+1F379",
                        "url": "https://util.unicode.org/UnicodeJsps/character.jsp?a=1F379"
                    }
                },
                {
                    "question": "Tonic water gets its bitter taste from quinine, which people originally drank to ward off which tropical disease?",
                    "answer": "Malaria",
                    "acceptable": [
                        "Malaria fever"
                    ],
                    "difficulty": "medium",
                    "topic": "Mixers",
                    "funFact": "Modern tonic water carries far less quinine than the original medicinal version, and a great deal more sugar.",
                    "source": {
                        "name": "Wikipedia — Tonic water",
                        "url": "https://en.wikipedia.org/wiki/Tonic_water"
                    }
                },
                {
                    "question": "In the 2006 film Casino Royale, James Bond invents a gin-and-vodka martini and names it after which character?",
                    "answer": "Vesper Lynd",
                    "acceptable": [
                        "Vesper",
                        "The Vesper",
                        "Lynd"
                    ],
                    "difficulty": "medium",
                    "topic": "Cocktails on film",
                    "funFact": "Asked if he named it for the bitter aftertaste, Bond says no — once you have tasted it, that is all you want to drink.",
                    "source": {
                        "name": "Wikipedia — Vesper (cocktail)",
                        "url": "https://en.wikipedia.org/wiki/Vesper_(cocktail)"
                    }
                },
                {
                    "question": "Which British mixer brand, launched in the mid-2000s, takes its name from the local nickname for the cinchona tree, whose bark produces quinine?",
                    "answer": "Fever-Tree",
                    "acceptable": [
                        "Fever Tree",
                        "Fevertree"
                    ],
                    "difficulty": "medium",
                    "topic": "Brands",
                    "funFact": "The company sources its quinine from one of the last plantations of original cinchona ledgeriana trees, in the Congo.",
                    "source": {
                        "name": "Fever-Tree — Our Story",
                        "url": "https://fever-tree.com/en-gb/our-story"
                    }
                },
                {
                    "question": "Created in New York in 2005 by bartender Sam Ross, which modern classic — Scotch whisky, honey, ginger and lemon — shares its name with a famous antibiotic?",
                    "answer": "Penicillin",
                    "acceptable": [
                        "The Penicillin",
                        "Penicillin cocktail"
                    ],
                    "difficulty": "hard",
                    "topic": "Modern classics",
                    "funFact": "It is finished with a float of smoky Lagavulin single malt from the Scottish island of Islay.",
                    "source": {
                        "name": "Wikipedia — Penicillin (cocktail)",
                        "url": "https://en.wikipedia.org/wiki/Penicillin_(cocktail)"
                    }
                },
                {
                    "question": "Which bitter, blood-red Italian cocktail — three ingredients in equal parts — was named the best-selling classic in the world's finest bars for the fourth time in 2025?",
                    "answer": "Negroni",
                    "acceptable": [
                        "The Negroni"
                    ],
                    "difficulty": "hard",
                    "topic": "Cocktail rankings",
                    "funFact": "It is equal parts gin, Campari and sweet red vermouth, officially garnished with half a slice of orange.",
                    "source": {
                        "name": "Drinks International — The bestselling classic cocktails at the world's best bars 2025",
                        "url": "https://drinksint.com/the-bestselling-classic-cocktails-at-the-worlds-best-bars-2025/"
                    }
                }
            ]
        },
        {
            "id": "music-backwards",
            "name": "Backwards Music",
            "icon": "⏪",
            "intro": "Ten enormously famous songs, thirty seconds each — but every clip is playing backwards. You only need the song title, not the artist, and humming along in reverse is entirely permitted.",
            "questions": [
                {
                    "question": "Clip 1, played backwards. Name the song — the relentlessly cheerful hit from the film Despicable Me 2, about feeling like a room without a roof.",
                    "answer": "Happy",
                    "acceptable": [
                        "Happy (Pharrell)",
                        "Happy - Pharrell Williams",
                        "Happy (From Despicable Me 2)",
                        "Because I'm Happy"
                    ],
                    "difficulty": "easy",
                    "topic": "UK Number 1 singles",
                    "funFact": "It spent four weeks at Number 1 in Britain and a remarkable ninety-two weeks inside the Official Singles Chart.",
                    "clip": {
                        "source": "itunes",
                        "trackId": 863835363,
                        "previewUrl": "https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview211/v4/ed/a0/19/eda019cf-2794-66d1-208d-2e2e74c26c3d/mzaf_16469762943852039623.plus.aac.p.m4a",
                        "artist": "Pharrell Williams",
                        "title": "Happy",
                        "year": 2013,
                        "storeUrl": "https://music.apple.com/gb/album/happy-from-despicable-me-2/863835302?i=863835363&uo=4",
                        "reverse": true
                    },
                    "source": {
                        "name": "Official Charts Company",
                        "url": "https://www.officialcharts.com/songs/pharrell-happy/"
                    }
                },
                {
                    "question": "Clip 2, played backwards. Name this children's singalong — a YouTube phenomenon about a whole family of sharks.",
                    "answer": "Baby Shark",
                    "acceptable": [
                        "Baby Shark Dance",
                        "Baby Shark Doo Doo Doo",
                        "Baby Shark Song",
                        "The Baby Shark song"
                    ],
                    "difficulty": "easy",
                    "topic": "Children's music and YouTube",
                    "funFact": "In January 2022 it became the first video in YouTube history to reach ten billion views.",
                    "clip": {
                        "source": "itunes",
                        "trackId": 1326203085,
                        "previewUrl": "https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview211/v4/a9/98/42/a99842bc-1b61-319d-1e6b-a8b00b4202cd/mzaf_8654180912987420194.plus.aac.p.m4a",
                        "artist": "Pinkfong",
                        "title": "Baby Shark",
                        "year": 2017,
                        "storeUrl": "https://music.apple.com/gb/album/baby-shark/1326202119?i=1326203085&uo=4",
                        "reverse": true
                    },
                    "source": {
                        "name": "Official Charts Company",
                        "url": "https://www.officialcharts.com/songs/pinkfong-baby-shark/"
                    }
                },
                {
                    "question": "Clip 3, played backwards. Name the song — the lead single from Taylor Swift's album 1989, and her big leap into pure pop.",
                    "answer": "Shake It Off",
                    "acceptable": [
                        "Shake it Off",
                        "Shake It Off (Taylor's Version)",
                        "Shake It Off - Taylor Swift"
                    ],
                    "difficulty": "easy",
                    "topic": "2010s pop",
                    "funFact": "It spent forty-three weeks on the Official Singles Chart yet never topped it, stalling at Number 2 in 2014.",
                    "clip": {
                        "source": "itunes",
                        "trackId": 1445888394,
                        "previewUrl": "https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview221/v4/82/9a/55/829a551a-461c-f1d8-818d-ddedb090791d/mzaf_3170634596127872695.plus.aac.p.m4a",
                        "artist": "Taylor Swift",
                        "title": "Shake It Off",
                        "year": 2014,
                        "storeUrl": "https://music.apple.com/gb/album/shake-it-off/1445888258?i=1445888394&uo=4",
                        "reverse": true
                    },
                    "source": {
                        "name": "Official Charts Company",
                        "url": "https://www.officialcharts.com/songs/taylor-swift-shake-it-off/"
                    }
                },
                {
                    "question": "Clip 4, played backwards. Name the song — a Coldplay track built on a huge string riff, sung by a king who has lost his throne.",
                    "answer": "Viva La Vida",
                    "acceptable": [
                        "Viva la Vida",
                        "Viva La Vida (Coldplay)",
                        "Long Live Life"
                    ],
                    "difficulty": "medium",
                    "topic": "British rock",
                    "funFact": "It entered at Number 1 in June 2008 and has since clocked up 166 weeks on the Official Singles Chart.",
                    "clip": {
                        "source": "itunes",
                        "trackId": 1122773680,
                        "previewUrl": "https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview211/v4/b0/19/60/b0196060-7786-24c0-8c56-8f628fe89f52/mzaf_12479456646715449366.plus.aac.p.m4a",
                        "artist": "Coldplay",
                        "title": "Viva La Vida",
                        "year": 2008,
                        "storeUrl": "https://music.apple.com/gb/album/viva-la-vida/1122773394?i=1122773680&uo=4",
                        "reverse": true
                    },
                    "source": {
                        "name": "Official Charts Company",
                        "url": "https://www.officialcharts.com/songs/coldplay-viva-la-vida/"
                    }
                },
                {
                    "question": "Clip 5, played backwards. Name the song — Rihanna's featuring-Jay-Z smash that ruled the summer of 2007 for ten straight weeks.",
                    "answer": "Umbrella",
                    "acceptable": [
                        "Umbrella (feat. Jay-Z)",
                        "Umbrella - Rihanna",
                        "Umbrella ft Jay-Z"
                    ],
                    "difficulty": "medium",
                    "topic": "UK Number 1 singles",
                    "funFact": "Ten weeks at Number 1 in Britain in 2007, and seventy-one weeks in total on the Official Singles Chart.",
                    "clip": {
                        "source": "itunes",
                        "trackId": 1441154437,
                        "previewUrl": "https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview211/v4/7b/45/22/7b452241-882c-409b-3a9b-23306b14286a/mzaf_8588243939716013218.plus.aac.p.m4a",
                        "artist": "Rihanna ft. Jay-Z",
                        "title": "Umbrella",
                        "year": 2007,
                        "storeUrl": "https://music.apple.com/gb/album/umbrella-feat-ja%C3%BF-z/1441154435?i=1441154437&uo=4",
                        "reverse": true
                    },
                    "source": {
                        "name": "Official Charts Company",
                        "url": "https://www.officialcharts.com/songs/rihanna-feat-jay-z-umbrella/"
                    }
                },
                {
                    "question": "Clip 6, played backwards. Name the song — the late Swedish DJ's 2013 mix of folk guitar and dance, from an album called True.",
                    "answer": "Wake Me Up",
                    "acceptable": [
                        "Wake Me Up!",
                        "Wake Me Up When It's All Over",
                        "Wake Me Up - Avicii"
                    ],
                    "difficulty": "medium",
                    "topic": "Dance music",
                    "funFact": "It spent three weeks at Number 1 in Britain in 2013 and has logged seventy-two weeks on the chart.",
                    "clip": {
                        "source": "itunes",
                        "trackId": 1440872929,
                        "previewUrl": "https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview221/v4/68/1e/60/681e601f-e1f2-4ebb-37de-adf00bdf57b6/mzaf_8266263075137964740.plus.aac.p.m4a",
                        "artist": "Avicii",
                        "title": "Wake Me Up",
                        "year": 2013,
                        "storeUrl": "https://music.apple.com/gb/album/wake-me-up/1440872730?i=1440872929&uo=4",
                        "reverse": true
                    },
                    "source": {
                        "name": "Official Charts Company",
                        "url": "https://www.officialcharts.com/songs/avicii-wake-me-up/"
                    }
                },
                {
                    "question": "Clip 7, played backwards. Name the song — a 2003 rock riff that became a chant on football terraces worldwide.",
                    "answer": "Seven Nation Army",
                    "acceptable": [
                        "7 Nation Army"
                    ],
                    "difficulty": "medium",
                    "topic": "Rock anthems",
                    "funFact": "It won Best Rock Song at the 2004 Grammys — Jack White's first Grammy with the White Stripes.",
                    "clip": {
                        "source": "itunes",
                        "trackId": 1533513537,
                        "previewUrl": "https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview221/v4/fe/2d/58/fe2d587f-6344-3fb3-43f7-d318a6253dcc/mzaf_16825320951570507954.plus.aac.p.m4a",
                        "artist": "The White Stripes",
                        "title": "Seven Nation Army",
                        "year": 2003,
                        "storeUrl": "https://music.apple.com/gb/album/seven-nation-army/1533513536?i=1533513537&uo=4",
                        "reverse": true
                    },
                    "source": {
                        "name": "The Recording Academy (Grammy.com)",
                        "url": "https://www.grammy.com/artists/jack-white/15627/"
                    }
                },
                {
                    "question": "Clip 8, played backwards. Name the song — the UK's best-selling single of 2012, built on a looping xylophone.",
                    "answer": "Somebody That I Used to Know",
                    "acceptable": [
                        "Somebody I Used to Know",
                        "Somebody That I Used To Know",
                        "Somebody That I Used To Know (feat. Kimbra)"
                    ],
                    "difficulty": "medium",
                    "topic": "2010s chart hits",
                    "funFact": "It was the UK's best-selling song of 2012, just ahead of Carly Rae Jepsen's Call Me Maybe.",
                    "clip": {
                        "source": "itunes",
                        "trackId": 1440764677,
                        "previewUrl": "https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview211/v4/31/5b/1f/315b1f83-77b5-9e43-e00e-8c5601abb59f/mzaf_3167206633193589804.plus.aac.p.m4a",
                        "artist": "Gotye ft. Kimbra",
                        "title": "Somebody That I Used to Know",
                        "year": 2011,
                        "storeUrl": "https://music.apple.com/gb/album/somebody-that-i-used-to-know-feat-kimbra/1440764665?i=1440764677&uo=4",
                        "reverse": true
                    },
                    "source": {
                        "name": "Official Charts Company",
                        "url": "https://www.officialcharts.com/songs/gotye-ft-kimbra-somebody-that-i-used-to-know/"
                    }
                },
                {
                    "question": "Clip 9, played backwards. Name the song — it won Record of the Year at the 2020 Grammys.",
                    "answer": "Bad Guy",
                    "acceptable": [
                        "bad guy",
                        "Badguy",
                        "Bad Guy (Billie Eilish)"
                    ],
                    "difficulty": "hard",
                    "topic": "Modern pop",
                    "funFact": "At 18, Billie Eilish swept Record, Song, Album of the Year and Best New Artist in one night.",
                    "clip": {
                        "source": "itunes",
                        "trackId": 1450695739,
                        "previewUrl": "https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview211/v4/c3/87/1f/c3871f7e-3260-d615-1c66-5fdca2c3a48f/mzaf_10721331211699880949.plus.aac.p.m4a",
                        "artist": "Billie Eilish",
                        "title": "Bad Guy",
                        "year": 2019,
                        "storeUrl": "https://music.apple.com/gb/album/bad-guy/1450695723?i=1450695739&uo=4",
                        "reverse": true
                    },
                    "source": {
                        "name": "The Recording Academy (Grammy.com)",
                        "url": "https://www.grammy.com/news/billie-eilish-wins-record-year-bad-guy-2020-grammys/"
                    }
                },
                {
                    "question": "Clip 10, played backwards. Name the song — a ballad from a 1939 film, voted the greatest song in American cinema by the American Film Institute.",
                    "answer": "Over the Rainbow",
                    "acceptable": [
                        "Somewhere Over the Rainbow",
                        "(Somewhere) Over the Rainbow",
                        "Somewhere Over The Rainbow",
                        "Over The Rainbow"
                    ],
                    "difficulty": "hard",
                    "topic": "Classic film music",
                    "funFact": "The American Film Institute voted it the number one song in American cinema, from The Wizard of Oz.",
                    "clip": {
                        "source": "itunes",
                        "trackId": 1454449433,
                        "previewUrl": "https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview211/v4/f8/96/d7/f896d784-0555-3954-36dc-2268e07cb483/mzaf_12971776910267287030.plus.aac.p.m4a",
                        "artist": "Judy Garland",
                        "title": "Over the Rainbow",
                        "year": 1939,
                        "storeUrl": "https://music.apple.com/gb/album/over-the-rainbow/1454449430?i=1454449433&uo=4",
                        "reverse": true
                    },
                    "source": {
                        "name": "American Film Institute",
                        "url": "https://www.afi.com/afis-100-years-100-songs/"
                    }
                }
            ]
        },
        {
            "id": "anatomy",
            "name": "Bones, Organs and Oddities",
            "icon": "🦴",
            "intro": "Everything in this round you are carrying around with you right now, free of charge. No phones — though you are allowed to prod your own kneecap.",
            "questions": [
                {
                    "question": "Which organ of the human body is the largest?",
                    "answer": "The skin",
                    "acceptable": [
                        "Skin",
                        "Your skin"
                    ],
                    "difficulty": "easy",
                    "topic": "Organs",
                    "funFact": "An adult's skin covers roughly 1.5 to 2 square metres and makes up about 15% of total body weight.",
                    "source": {
                        "name": "Encyclopaedia Britannica — Human skin",
                        "url": "https://www.britannica.com/science/human-skin"
                    }
                },
                {
                    "question": "How many bones are there in a typical adult human skeleton?",
                    "answer": "206",
                    "acceptable": [
                        "Two hundred and six",
                        "206 bones",
                        "About 206"
                    ],
                    "difficulty": "easy",
                    "topic": "Bones",
                    "funFact": "Babies are born with roughly 270 to 300 bones — sources differ — and many fuse together as a child grows.",
                    "source": {
                        "name": "Encyclopaedia Britannica — Skeleton",
                        "url": "https://www.britannica.com/science/skeleton"
                    }
                },
                {
                    "question": "What is the longest bone in the human body?",
                    "answer": "The femur",
                    "acceptable": [
                        "Femur",
                        "Thigh bone",
                        "Thighbone"
                    ],
                    "difficulty": "easy",
                    "topic": "Bones",
                    "funFact": "It is also the heaviest and thickest bone you own, and the only bone in the thigh.",
                    "source": {
                        "name": "TeachMeAnatomy — The Femur",
                        "url": "https://teachmeanatomy.info/lower-limb/bones/femur/"
                    }
                },
                {
                    "question": "What is the medical name for the kneecap?",
                    "answer": "The patella",
                    "acceptable": [
                        "Patella",
                        "Patella bone"
                    ],
                    "difficulty": "medium",
                    "topic": "Bones",
                    "funFact": "The patella sits inside a tendon rather than joining two bones — it is the body's largest sesamoid bone.",
                    "source": {
                        "name": "NHS — Dislocated kneecap",
                        "url": "https://www.nhs.uk/conditions/dislocated-kneecap/"
                    }
                },
                {
                    "question": "According to NHS Blood Donation, which blood group is the most common in the UK?",
                    "answer": "O positive",
                    "acceptable": [
                        "O pos",
                        "O+",
                        "O positive blood",
                        "Group O positive"
                    ],
                    "difficulty": "medium",
                    "topic": "Blood",
                    "funFact": "Around 36% of UK donors are O positive, which is why the blood service always wants more of it.",
                    "source": {
                        "name": "NHS Blood Donation — Blood types",
                        "url": "https://www.blood.co.uk/why-give-blood/blood-types/"
                    }
                },
                {
                    "question": "Which organ of the body produces the hormone insulin?",
                    "answer": "The pancreas",
                    "acceptable": [
                        "Pancreas"
                    ],
                    "difficulty": "medium",
                    "topic": "Organs",
                    "funFact": "The pancreas also makes glucagon, insulin's opposite number, which pushes blood sugar back up again.",
                    "source": {
                        "name": "Encyclopaedia Britannica — Pancreas",
                        "url": "https://www.britannica.com/science/pancreas"
                    }
                },
                {
                    "question": "According to NHS Blood and Transplant, which organ is the most commonly transplanted in the UK?",
                    "answer": "The kidney",
                    "acceptable": [
                        "Kidney",
                        "Kidneys",
                        "A kidney"
                    ],
                    "difficulty": "medium",
                    "topic": "Organs and transplants",
                    "funFact": "Most people have two kidneys but can live a full and healthy life with only one.",
                    "source": {
                        "name": "NHS Blood and Transplant — Kidney transplantation",
                        "url": "https://www.nhsbt.nhs.uk/organ-transplantation/kidney/"
                    }
                },
                {
                    "question": "Guinness World Records lists the tallest living man as a Turkish man measuring 251 centimetres, or 8 feet 2.8 inches. What is his name?",
                    "answer": "Sultan Kösen",
                    "acceptable": [
                        "Kösen",
                        "Kosen",
                        "Sultan Kosen",
                        "Sultan"
                    ],
                    "difficulty": "medium",
                    "topic": "Body records",
                    "funFact": "He was measured in Ankara in February 2011 and has held the record ever since.",
                    "source": {
                        "name": "Guinness World Records — Tallest man living",
                        "url": "https://www.guinnessworldrecords.com/world-records/tallest-man-living"
                    }
                },
                {
                    "question": "Bang your 'funny bone' and there is no bone involved at all — you have squashed a nerve at the elbow. Which nerve?",
                    "answer": "The ulnar nerve",
                    "acceptable": [
                        "Ulnar",
                        "Ulnar nerve",
                        "Ulna",
                        "Funny bone nerve"
                    ],
                    "difficulty": "hard",
                    "topic": "Nerves",
                    "funFact": "Compress it for long enough and you get cubital tunnel syndrome — the funny bone's decidedly unfunny version.",
                    "source": {
                        "name": "Swansea Bay University Health Board (NHS Wales) — Cubital tunnel syndrome",
                        "url": "https://sbuhb.nhs.wales/hospitals/a-z-services/physiotherapy/musculoskeletal-physiotherapy/hand-wrist-pain/cubital-tunnel-syndrome/"
                    }
                },
                {
                    "question": "Which U-shaped bone in the throat is the only bone in the human body not joined to any other bone?",
                    "answer": "The hyoid",
                    "acceptable": [
                        "Hyoid",
                        "Hyoid bone",
                        "The floating bone"
                    ],
                    "difficulty": "hard",
                    "topic": "Bones",
                    "funFact": "It floats in the neck, slung on muscles alone, and helps you swallow and speak.",
                    "source": {
                        "name": "Encyclopaedia Britannica — Hyoid bone",
                        "url": "https://www.britannica.com/science/hyoid-bone"
                    }
                }
            ]
        },
        {
            "id": "board-games",
            "name": "Board Games & Toys",
            "icon": "🎲",
            "intro": "Round three: Board Games and Toys. Everything from the thing that's on your shelf right now to the London shop that's been selling toys since George III was on the throne — pens ready.",
            "questions": [
                {
                    "question": "In February 2026, the most expensive trading card ever sold at auction went for 16.5 million dollars — about 13 million pounds. Which Pokémon is on it?",
                    "answer": "Pikachu",
                    "acceptable": [
                        "Pikachu",
                        "Pikachu Illustrator",
                        "the Pikachu Illustrator card",
                        "Pika"
                    ],
                    "difficulty": "easy",
                    "topic": "Pokémon cards",
                    "funFact": "Fewer than forty exist, handed out as prizes in a Japanese illustration contest. Logan Paul had paid 5.275 million for it in 2021.",
                    "source": {
                        "name": "Guinness World Records",
                        "url": "https://www.guinnessworldrecords.com/news/2026/2/logan-pauls-rare-pokemon-card-becomes-most-expensive-ever-sold-in-record-setting-auction"
                    }
                },
                {
                    "question": "Guinness World Records credits which toy company with churning out more tyres every year than any other manufacturer on the planet?",
                    "answer": "Lego",
                    "acceptable": [
                        "Lego",
                        "LEGO",
                        "The LEGO Group",
                        "Lego Group"
                    ],
                    "difficulty": "easy",
                    "topic": "Lego",
                    "funFact": "Lego peaked at 381 million tiny rubber tyres in 2010, which is well over a million a day.",
                    "source": {
                        "name": "Guinness World Records",
                        "url": "https://www.guinnessworldrecords.com/world-records/100909-largest-tyre-manufacture-per-annum"
                    }
                },
                {
                    "question": "Before it was rebranded as a children's toy in the 1950s, Play-Doh was sold as a cleaner for what?",
                    "answer": "Wallpaper",
                    "acceptable": [
                        "wallpaper",
                        "wallpaper cleaner",
                        "cleaning wallpaper",
                        "getting soot off wallpaper",
                        "walls"
                    ],
                    "difficulty": "easy",
                    "topic": "Play-Doh",
                    "funFact": "Coal fires left soot on wallpaper. When homes switched to gas heating the cleaner flopped, so they sold it to children instead.",
                    "source": {
                        "name": "The Strong National Museum of Play",
                        "url": "https://www.museumofplay.org/blog/the-history-of-play-doh-good-clean-fun/"
                    }
                },
                {
                    "question": "In the standard 55-card deck of the fast-matching game Dobble, how many symbols are printed on each card?",
                    "answer": "Eight",
                    "acceptable": [
                        "8",
                        "eight"
                    ],
                    "difficulty": "medium",
                    "topic": "Dobble",
                    "funFact": "Any two of the 55 cards share exactly one symbol. The maths behind that trick is called a projective plane.",
                    "source": {
                        "name": "Asmodee UK",
                        "url": "https://www.asmodee.co.uk/blogs/news/how-to-play-dobble"
                    }
                },
                {
                    "question": "In 2016, Cluedo dropped one of its six original suspects for the first time since 1949 and brought in Dr Orchid. Which suspect got the chop?",
                    "answer": "Mrs White",
                    "acceptable": [
                        "Mrs White",
                        "Mrs. White",
                        "Miss White",
                        "White",
                        "the housekeeper"
                    ],
                    "difficulty": "medium",
                    "topic": "Cluedo",
                    "funFact": "Dr Orchid holds a PhD in plant toxicology, making her the first Cluedo woman with a job outside the house.",
                    "source": {
                        "name": "TIME",
                        "url": "https://time.com/4401819/clue-board-game-dr-orchid-mrs-white/"
                    }
                },
                {
                    "question": "In 2017, Monopoly fans voted out the boot, the thimble and the wheelbarrow. Name any one of the three tokens that replaced them.",
                    "answer": "T. rex, penguin or rubber duck",
                    "acceptable": [
                        "T. rex",
                        "T-rex",
                        "T rex",
                        "tyrannosaurus rex",
                        "tyrannosaurus",
                        "dinosaur",
                        "penguin",
                        "rubber duck",
                        "rubber ducky",
                        "duck"
                    ],
                    "difficulty": "medium",
                    "topic": "Monopoly",
                    "funFact": "More than 4.3 million people voted from over 100 countries. The Scottie dog, as ever, survived.",
                    "source": {
                        "name": "ABC News",
                        "url": "https://www.abc.net.au/news/2017-03-18/monopoly-tokens-thimble-wheelbarrow-boot-replaced/8366296"
                    }
                },
                {
                    "question": "Which card game — all about cats, and one card you really do not want to draw — became the most-backed project in Kickstarter's entire history back in 2015?",
                    "answer": "Exploding Kittens",
                    "acceptable": [
                        "Exploding Kittens",
                        "Exploding Kitten"
                    ],
                    "difficulty": "medium",
                    "topic": "Kickstarter games",
                    "funFact": "It asked for ten thousand dollars and finished with 8.7 million from 219,382 backers.",
                    "source": {
                        "name": "Wikipedia",
                        "url": "https://en.wikipedia.org/wiki/Exploding_Kittens"
                    }
                },
                {
                    "question": "Which London toy shop, opened in 1760 and now sprawling over seven floors of Regent Street, boasts of being the oldest toy shop in the world?",
                    "answer": "Hamleys",
                    "acceptable": [
                        "Hamleys",
                        "Hamley's",
                        "Hamleys of London",
                        "Hamleys of Regent Street"
                    ],
                    "difficulty": "medium",
                    "topic": "Toy shops",
                    "funFact": "Cornishman William Hamley opened it in Holborn under a much better name: Noah's Ark.",
                    "source": {
                        "name": "London Museum",
                        "url": "https://www.londonmuseum.org.uk/collections/london-stories/hamleys-regent-streets-toy-wonderland/"
                    }
                },
                {
                    "question": "In February 2026, Poland's Teodor Zajder became the first person ever to officially solve a Rubik's Cube, in a single solve, in under how many seconds?",
                    "answer": "Three seconds",
                    "acceptable": [
                        "3",
                        "three",
                        "3 seconds",
                        "three seconds",
                        "under 3 seconds",
                        "2.76",
                        "2.76 seconds"
                    ],
                    "difficulty": "hard",
                    "topic": "Rubik's Cube",
                    "funFact": "Zajder was nine years old. His 2.76 seconds beat the old record by 0.29, a huge leap in speedcubing terms.",
                    "source": {
                        "name": "Guinness World Records",
                        "url": "https://www.guinnessworldrecords.com/world-records/72863-fastest-time-to-solve-a-rubiks-cube"
                    }
                },
                {
                    "question": "Which Nottingham-based British company, the maker of Warhammer, was promoted into the FTSE 100 in December 2024?",
                    "answer": "Games Workshop",
                    "acceptable": [
                        "Games Workshop",
                        "Games Workshop Group",
                        "GW"
                    ],
                    "difficulty": "hard",
                    "topic": "Warhammer",
                    "funFact": "Little plastic space marines now sit in the same index as BP and Tesco. Games Workshop joined on 20 December 2024.",
                    "source": {
                        "name": "LSEG / FTSE Russell",
                        "url": "https://www.lseg.com/en/media-centre/press-releases/ftse-russell/2024/ftse-uk-index-series-review-december-2024"
                    }
                }
            ]
        },
        {
            "id": "brands",
            "name": "Own Brand",
            "icon": "🛒",
            "intro": "This round is about the brands you cannot get away from — the ones in your trolley, on the high street and in every ad break. If you have been to a supermarket this year, you are already qualified.",
            "questions": [
                {
                    "question": "Which American toy company makes Barbie and Hot Wheels, and co-produced the 2023 Barbie film?",
                    "answer": "Mattel",
                    "acceptable": [
                        "Mattel",
                        "Mattel Inc",
                        "Mattel Films"
                    ],
                    "difficulty": "easy",
                    "topic": "Toys",
                    "funFact": "The 2023 Barbie was the very first film Mattel Films ever released.",
                    "source": {
                        "name": "Wikipedia - Mattel",
                        "url": "https://en.wikipedia.org/wiki/Mattel"
                    }
                },
                {
                    "question": "Kevin the Carrot is the star of which supermarket's Christmas adverts?",
                    "answer": "Aldi",
                    "acceptable": [
                        "Aldi",
                        "Aldi UK"
                    ],
                    "difficulty": "easy",
                    "topic": "Supermarkets and advertising",
                    "funFact": "Kevin debuted in 2016, and in 2025 he finally proposed to Katie the Carrot.",
                    "source": {
                        "name": "Aldi UK Press Centre - Kevin pops the question to Katie",
                        "url": "https://www.aldipresscentre.co.uk/product-news/aldi-launches-limited-edition-carrot-gold-engagement-rings-after-kevin-the-carrot-finally-popped-the-question-to-katie/"
                    }
                },
                {
                    "question": "In 2019 Greggs caused a national media storm by launching a vegan version of which of its products?",
                    "answer": "The sausage roll",
                    "acceptable": [
                        "Sausage roll",
                        "The sausage roll",
                        "Vegan sausage roll",
                        "Greggs sausage roll",
                        "Meat-free sausage roll"
                    ],
                    "difficulty": "easy",
                    "topic": "Food brands",
                    "funFact": "The filling is Quorn — and Greggs upgraded its profit forecast twice on the back of it.",
                    "source": {
                        "name": "Wikipedia - Meat-free sausage roll",
                        "url": "https://en.wikipedia.org/wiki/Meat-free_sausage_roll"
                    }
                },
                {
                    "question": "Aleksandr Orlov, the meerkat whose catchphrase is \"Simples\", advertises which price comparison website?",
                    "answer": "Compare the Market",
                    "acceptable": [
                        "Compare the Market",
                        "Comparethemarket",
                        "comparethemarket.com",
                        "Compare the Meerkat"
                    ],
                    "difficulty": "medium",
                    "topic": "Advertising",
                    "funFact": "The whole joke is that \"market\" sounds like \"meerkat\". The campaign launched on 5 January 2009.",
                    "source": {
                        "name": "Wikipedia - Compare the Meerkat",
                        "url": "https://en.wikipedia.org/wiki/Compare_the_Meerkat"
                    }
                },
                {
                    "question": "The Dulux paint brand's long-running mascot is a big shaggy white and grey dog. What breed is it?",
                    "answer": "Old English Sheepdog",
                    "acceptable": [
                        "Old English Sheepdog",
                        "Old English Sheep Dog",
                        "Bobtail",
                        "Old English"
                    ],
                    "difficulty": "medium",
                    "topic": "Mascots and dog breeds",
                    "funFact": "The first Dulux dog appeared in a 1961 advert, and the breed has been nicknamed the Dulux Dog ever since.",
                    "source": {
                        "name": "Dulux UK - 60 years of the Dulux Old English Sheepdog",
                        "url": "https://www.dulux.co.uk/en/celebrating-90-years-with-dulux-interiors-inspiration-and-decorating-tips/60-years-of-the-dulux-old-english-sheepdog"
                    }
                },
                {
                    "question": "The name LEGO is a squashed-together version of the two Danish words \"leg godt\". What do those words mean in English?",
                    "answer": "Play well",
                    "acceptable": [
                        "Play well",
                        "Play good",
                        "Play nicely"
                    ],
                    "difficulty": "medium",
                    "topic": "Toys",
                    "funFact": "The brick in the form we know it, with the tubes underneath, was only launched in 1958.",
                    "source": {
                        "name": "The LEGO Group - Official history",
                        "url": "https://www.lego.com/en-gb/aboutus/lego-group/the-lego-group-history"
                    }
                },
                {
                    "question": "On Irish high streets the shops we know as Primark trade under a completely different name — the chain's own original name. What is it?",
                    "answer": "Penneys",
                    "acceptable": [
                        "Penneys",
                        "Penney's",
                        "Pennys",
                        "Primark Penneys"
                    ],
                    "difficulty": "medium",
                    "topic": "Retail brands",
                    "funFact": "American chain J. C. Penney objected to the name, so the shops outside the Republic of Ireland were rebranded Primark.",
                    "source": {
                        "name": "Wikipedia - Primark",
                        "url": "https://en.wikipedia.org/wiki/Primark"
                    }
                },
                {
                    "question": "The Nectar loyalty card scheme is owned and run by which British supermarket?",
                    "answer": "Sainsbury's",
                    "acceptable": [
                        "Sainsbury's",
                        "Sainsburys",
                        "Sainsbury",
                        "J Sainsbury",
                        "J Sainsbury plc"
                    ],
                    "difficulty": "medium",
                    "topic": "Supermarkets",
                    "funFact": "Nectar launched in 2002 with Sainsbury's, BP, Barclaycard and Debenhams; Sainsbury's bought the whole scheme in 2018.",
                    "source": {
                        "name": "Wikipedia - Nectar (loyalty card)",
                        "url": "https://en.wikipedia.org/wiki/Nectar_(loyalty_card)"
                    }
                },
                {
                    "question": "Cadbury was bought by America's Kraft in a deeply unpopular 2010 takeover. When Kraft then split itself in two, which company ended up owning Cadbury, and still does today?",
                    "answer": "Mondelez International",
                    "acceptable": [
                        "Mondelez",
                        "Mondelez International",
                        "Mondelez Intl",
                        "Mondelēz"
                    ],
                    "difficulty": "hard",
                    "topic": "Ownership",
                    "funFact": "Kraft paid £8.40 a share, valuing Cadbury at £11.5 billion, then split off the snacks half in October 2012.",
                    "source": {
                        "name": "Wikipedia - Cadbury",
                        "url": "https://en.wikipedia.org/wiki/Cadbury"
                    }
                },
                {
                    "question": "In February 2018 KFC had to shut hundreds of its UK restaurants after running out of chicken. Which delivery company had just taken over its deliveries?",
                    "answer": "DHL",
                    "acceptable": [
                        "DHL",
                        "DHL Supply Chain",
                        "DHL Group",
                        "Deutsche Post DHL"
                    ],
                    "difficulty": "hard",
                    "topic": "High street brands",
                    "funFact": "KFC apologised with a newspaper advert showing an empty bucket, its letters rearranged to read \"FCK\".",
                    "source": {
                        "name": "Wikipedia - KFC",
                        "url": "https://en.wikipedia.org/wiki/KFC"
                    }
                }
            ]
        },
        {
            "id": "emoji-equations",
            "name": "Emoji Equations",
            "icon": "🧩",
            "intro": "Every question is two emoji added together, and they add up to a word or a short phrase — the trick is to say them out loud and listen. Some answers are two words, so don't stop at the first one that fits.",
            "questions": [
                {
                    "question": "⭐ + 🐟 = ?",
                    "answer": "Starfish",
                    "acceptable": [
                        "star fish",
                        "sea star"
                    ],
                    "difficulty": "easy",
                    "topic": "Wordplay — sea creatures",
                    "funFact": "Starfish are not fish at all — they have no gills, scales or fins, so scientists often say sea star instead.",
                    "source": {
                        "name": "Britannica Dictionary",
                        "url": "https://www.britannica.com/dictionary/starfish"
                    }
                },
                {
                    "question": "🌧️ + 🦌 = ?",
                    "answer": "Reindeer",
                    "acceptable": [
                        "rain deer",
                        "rain-deer"
                    ],
                    "difficulty": "easy",
                    "topic": "Wordplay — animals",
                    "funFact": "Reindeer are the only deer whose females can grow antlers too, though how many of them do varies hugely between populations.",
                    "source": {
                        "name": "Britannica Dictionary",
                        "url": "https://www.britannica.com/dictionary/reindeer"
                    }
                },
                {
                    "question": "🍯 + 🌙 = ?",
                    "answer": "Honeymoon",
                    "acceptable": [
                        "honey moon",
                        "honey-moon"
                    ],
                    "difficulty": "easy",
                    "topic": "Wordplay — weddings",
                    "funFact": "Moon here probably just means month — though one old suggestion is that affection wanes like the moon after the wedding.",
                    "source": {
                        "name": "Britannica Dictionary",
                        "url": "https://www.britannica.com/dictionary/honeymoon"
                    }
                },
                {
                    "question": "🐌 + ✉️ = ?",
                    "answer": "Snail mail",
                    "acceptable": [
                        "snailmail",
                        "snail-mail"
                    ],
                    "difficulty": "medium",
                    "topic": "Wordplay — post",
                    "funFact": "The phrase only exists because email arrived — nobody needed a nickname for ordinary post before that.",
                    "source": {
                        "name": "Britannica Dictionary",
                        "url": "https://www.britannica.com/dictionary/snail-mail"
                    }
                },
                {
                    "question": "🧅 + 💍 = ?",
                    "answer": "Onion ring",
                    "acceptable": [
                        "onion rings",
                        "onion-ring"
                    ],
                    "difficulty": "medium",
                    "topic": "Wordplay — food",
                    "funFact": "The earliest known recipe is from 1802, by British food writer John Mollard — battered with Parmesan and fried in lard.",
                    "source": {
                        "name": "Merriam-Webster",
                        "url": "https://www.merriam-webster.com/dictionary/onion%20ring"
                    }
                },
                {
                    "question": "🐻 + 🦶 = ?",
                    "answer": "Barefoot",
                    "acceptable": [
                        "bare foot",
                        "bare feet",
                        "barefooted",
                        "bare-foot"
                    ],
                    "difficulty": "medium",
                    "topic": "Wordplay — homophones",
                    "funFact": "Abebe Bikila won the 1960 Olympic marathon in Rome running the entire race with nothing on his feet.",
                    "source": {
                        "name": "Britannica Dictionary",
                        "url": "https://www.britannica.com/dictionary/barefoot"
                    }
                },
                {
                    "question": "🛋️ + 🥔 = ?",
                    "answer": "Couch potato",
                    "acceptable": [
                        "couch-potato",
                        "couchpotato"
                    ],
                    "difficulty": "medium",
                    "topic": "Wordplay — idioms",
                    "funFact": "Coined in 1976 by Tom Iacino, a friend of the American underground comics artist Robert Armstrong.",
                    "source": {
                        "name": "Britannica Dictionary",
                        "url": "https://www.britannica.com/dictionary/couch-potato"
                    }
                },
                {
                    "question": "👻 + ✍️ = ?",
                    "answer": "Ghostwriter",
                    "acceptable": [
                        "ghost writer",
                        "ghost-writer",
                        "ghostwriting",
                        "ghost writing"
                    ],
                    "difficulty": "medium",
                    "topic": "Wordplay — books",
                    "funFact": "Nancy Drew's author Carolyn Keene never existed — it is a shared pen name used by a whole succession of hired writers.",
                    "source": {
                        "name": "Merriam-Webster",
                        "url": "https://www.merriam-webster.com/dictionary/ghostwriter"
                    }
                },
                {
                    "question": "🐊 + 😢 = ?",
                    "answer": "Crocodile tears",
                    "acceptable": [
                        "crocodile tear",
                        "crocodile-tears"
                    ],
                    "difficulty": "hard",
                    "topic": "Wordplay — idioms",
                    "funFact": "Crocodilians really do weep while eating — a 2006 study filmed seven caimans feeding and five of them teared up.",
                    "source": {
                        "name": "Britannica Dictionary",
                        "url": "https://www.britannica.com/dictionary/crocodile-tears"
                    }
                },
                {
                    "question": "🍐 + 🐜 = ?",
                    "answer": "Parent",
                    "acceptable": [
                        "parents",
                        "a parent"
                    ],
                    "difficulty": "hard",
                    "topic": "Wordplay — homophones",
                    "funFact": "It comes from Latin parens, from the verb parire, meaning to bring forth or give birth.",
                    "source": {
                        "name": "Britannica Dictionary",
                        "url": "https://www.britannica.com/dictionary/parent"
                    }
                }
            ]
        }
    ],
    "tiebreaker": {
        "question": "The Lego World Map, set number 31203, is one of the biggest Lego sets ever put on sale. How many pieces are in the box? Nearest wins.",
        "answer": 11695,
        "unit": "pieces",
        "funFact": "It went on sale in 2021 and stayed in the shops until the end of 2023, and the pieces are almost all little round studs.",
        "source": {
            "name": "Brickset - 31203 World Map",
            "url": "https://brickset.com/sets/31203-1/World-Map"
        }
    }
};

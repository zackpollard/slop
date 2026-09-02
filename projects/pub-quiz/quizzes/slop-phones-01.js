/*
 * Phones Out — three rounds where the phone is a controller, not an answer sheet.
 *
 * Every answer here is ABSOLUTE: a position on a scale, a call of higher or
 * lower, a set of tiles. There is nothing to spell and therefore nothing to
 * mark, adjudicate or argue about — scoring is arithmetic on two values, done by
 * pure functions in js/formats.js.
 *
 * These rounds need phones. The host can enter any table's answer by hand, so a
 * flat battery is an inconvenience rather than a blocker, but a night with no
 * devices at all should pick a different pack.
 *
 * How each one plays is described in PHONES.md. The data shapes are enforced by
 * validateFormatQuestion() and rejected at import, not at 8pm.
 */

export default {
    "id": "slop-phones-01",
    "name": "Phones Out",
    "description": "Three rounds played on phones, where the answer is absolute: a number set on a dial, a ladder of higher-or-lowers you can bank at any moment, and a board where anything both tables pick is worth nothing to either of them. Nothing here is marked by hand, because a gesture has no spelling.",
    "author": "slop.zackpollard.pro",
    "createdOn": "2026-08-31",
    "version": 1,
    "tags": [
        "phones",
        "party",
        "family"
    ],
    "rounds": [
        {
            "id": "dial",
            "name": "The Dial",
            "icon": "🎚️",
            "intro": "Six numbers, and nobody in this room knows any of them for certain. Each one comes with a scale on your phone: slide to where you think the answer sits, and lock it in. Lock before you have heard a single clue and it is worth three times as much. Every clue I read makes the guess easier and the payout smaller, so the only real question is how brave you are feeling. You do not have to know. You have to argue your way to something sensible.",
            "format": "dial",
            "questions": [
                {
                    "id": "dial-q1",
                    "question": "How tall, in feet, is Hyperia — the rollercoaster that opened at Thorpe Park in May 2024?",
                    "answer": 236,
                    "min": 60,
                    "max": 300,
                    "unit": "feet",
                    "clues": [
                        "Thorpe Park bills it as the tallest and the fastest rollercoaster in the UK.",
                        "It tops eighty miles an hour at the bottom of the first drop, and the whole track is just under a kilometre long.",
                        "The loop on its own stands more than a hundred and fifty feet — and the loop is nowhere near the highest point of the ride."
                    ],
                    "difficulty": "easy",
                    "topic": "Theme parks",
                    "funFact": "Thorpe Park calls the ride's outer-banked airtime hill a world first. Riders get 14.8 seconds of airtime and pull up to 4.3G on the way round.",
                    "source": {
                        "name": "Thorpe Park Resort — Hyperia",
                        "url": "https://www.thorpepark.com/explore/theme-park/rides/hyperia/"
                    }
                },
                {
                    "id": "dial-q2",
                    "question": "How many miles long is Hadrian's Wall, coast to coast?",
                    "answer": 73,
                    "min": 20,
                    "max": 200,
                    "unit": "miles",
                    "clues": [
                        "It crosses the narrow neck of northern England: Wallsend on the River Tyne in the east, to Bowness-on-Solway in Cumbria in the west.",
                        "Walkers who follow it end to end on the modern National Trail cover eighty-four miles, and that path wanders about rather more than the wall did.",
                        "The Romans put a small fort — a milecastle — at every Roman mile along it. There were eighty milecastles, and a Roman mile is a little shorter than one of ours."
                    ],
                    "difficulty": "medium",
                    "topic": "Roman Britain",
                    "funFact": "As well as the milecastles it carried 16 full forts and 156 turrets, and at its tallest the wall stood about 15 feet high.",
                    "source": {
                        "name": "English Heritage — Hadrian's Wall facts and FAQs",
                        "url": "https://www.english-heritage.org.uk/faqs-hadrians-wall/"
                    }
                },
                {
                    "id": "dial-q3",
                    "question": "How many medals did ParalympicsGB win altogether at the Paris 2024 Paralympic Games?",
                    "answer": 124,
                    "min": 60,
                    "max": 155,
                    "unit": "medals",
                    "clues": [
                        "Two hundred and fifteen athletes made up the squad that went to Paris, and more than half of them came home with a medal round their neck.",
                        "Forty-nine of the medals were gold — eight more golds than they had won in Tokyo three years earlier.",
                        "Their total in Tokyo was a hundred and sixteen, and Paris beat it."
                    ],
                    "difficulty": "easy",
                    "topic": "The Paralympics",
                    "funFact": "They finished second in the medal table for the third Games running, and won medals in 18 of the 19 sports they entered — matching the record for the most sports any nation has taken medals in at a single Games.",
                    "source": {
                        "name": "ParalympicsGB — ParalympicsGB surpass Tokyo achievements at thrilling Paris 2024",
                        "url": "https://paralympics.org.uk/articles/paralympicsgb-surpass-tokyo-achievements-at-thrilling-paris"
                    }
                },
                {
                    "id": "dial-q4",
                    "question": "How many houses did the Great Fire of London destroy in 1666?",
                    "answer": 13200,
                    "min": 7500,
                    "max": 26000,
                    "unit": "houses",
                    "clues": [
                        "It broke out in a bakery on Pudding Lane and burned for four days, taking four fifths of the City of London — the old walled square mile, not London as we know it now.",
                        "Eighty-seven parish churches went up with it.",
                        "Around a hundred thousand Londoners were left homeless, and the houses of the day were narrow, timber-framed and crammed together, very often with more than one family under a roof."
                    ],
                    "difficulty": "hard",
                    "topic": "London history",
                    "funFact": "Fewer than ten deaths were ever officially recorded, although the real toll was almost certainly higher — the poor were rarely counted.",
                    "source": {
                        "name": "London Museum — The Great Fire of London",
                        "url": "https://www.londonmuseum.org.uk/collections/london-stories/great-fire-of-london/"
                    }
                },
                {
                    "id": "dial-q5",
                    "question": "When Greggs published its annual results, how many shops did it say it had trading at the end of December 2025?",
                    "answer": 2739,
                    "min": 800,
                    "max": 3500,
                    "unit": "shops",
                    "clues": [
                        "The chain took two point one five billion pounds in sales that year.",
                        "Around two thousand of its shops now stay open beyond five in the evening, and at least half of those until seven.",
                        "Greggs says there is room in the UK for significantly more than three thousand shops in the long run — and across 2025 it opened a hundred and twenty-one more than it closed."
                    ],
                    "difficulty": "medium",
                    "topic": "The high street",
                    "funFact": "Greggs opened its 2,700th shop in November 2025, and employs more than 33,000 people across the UK.",
                    "source": {
                        "name": "Greggs plc — 2025 Preliminary Results",
                        "url": "https://assets.greggs.com/f/162306/x/e616871d6c/260303-greggs-2025-preliminary-results-final.pdf"
                    }
                },
                {
                    "id": "dial-q6",
                    "question": "In millimetres, what is the most rain ever recorded anywhere in the UK in a single twenty-four-hour period?",
                    "answer": 341.4,
                    "min": 60,
                    "max": 500,
                    "unit": "millimetres",
                    "clues": [
                        "For scale: the wettest three days ever recorded in the UK came to four hundred and fifty-six millimetres, in Cumbria in November 2009. This is one day.",
                        "It fell at Honister Pass in the Lake District during Storm Desmond in December 2015 — and the same storm set the two-day record of four hundred and five millimetres, at Thirlmere a couple of valleys over.",
                        "It beat the previous twenty-four-hour record of three hundred and sixteen point four millimetres, set six years earlier at Seathwaite in Borrowdale, a few miles down the same valley."
                    ],
                    "difficulty": "hard",
                    "topic": "Weather",
                    "funFact": "The same December, Crib Goch on Snowdon recorded 1,396.4 mm — the wettest calendar month ever measured anywhere in the UK. If anyone argues the number, the record for a standard nine-to-nine rainfall day is lower: 279 mm at Martinstown in Dorset, back in 1955.",
                    "source": {
                        "name": "Met Office — UK climate extremes",
                        "url": "https://www.metoffice.gov.uk/research/climate/maps-and-data/uk-climate-extremes"
                    }
                }
            ]
        },
        {
            "id": "climb",
            "name": "The Climb",
            "icon": "🪜",
            "intro": "Four ladders, six rungs each. You see one rung at a time and call whether the next one is higher or lower. Every correct call doubles your pile; one wrong call and the lot is gone. Bank whenever your nerve goes — nobody else can see you do it.",
            "format": "climb",
            "questions": [
                {
                    "question": "Higher or lower — the weight in kilograms the official Pokedex gives each of these Pokemon in its standard form (ignore Mega Evolutions, Gigantamax forms and regional variants).",
                    "answer": "Blastoise 85.5 kg, Gengar 40.5 kg, Machamp 130 kg, Lucario 54 kg, Venusaur 100 kg, Mewtwo 122 kg — so the calls are: lower, higher, lower, higher, higher.",
                    "difficulty": "medium",
                    "topic": "Pokemon",
                    "funFact": "Mega Evolution usually changes a Pokemon's listed weight — but not Gengar's. The official Pokedex gives Mega Gengar exactly the same weight as an ordinary Gengar, while Mega Blastoise puts on well over a stone.",
                    "source": {
                        "name": "The official Pokemon Pokedex (Pokemon.com UK) — one page per Pokemon, linked on each rung",
                        "url": "https://www.pokemon.com/uk/pokedex"
                    },
                    "rungs": [
                        {
                            "label": "Blastoise",
                            "value": 85.5,
                            "source": {
                                "name": "Official Pokedex — Blastoise (standard form)",
                                "url": "https://www.pokemon.com/uk/pokedex/blastoise"
                            }
                        },
                        {
                            "label": "Gengar",
                            "value": 40.5,
                            "source": {
                                "name": "Official Pokedex — Gengar (standard form)",
                                "url": "https://www.pokemon.com/uk/pokedex/gengar"
                            }
                        },
                        {
                            "label": "Machamp",
                            "value": 130,
                            "source": {
                                "name": "Official Pokedex — Machamp",
                                "url": "https://www.pokemon.com/uk/pokedex/machamp"
                            }
                        },
                        {
                            "label": "Lucario",
                            "value": 54,
                            "source": {
                                "name": "Official Pokedex — Lucario (standard form)",
                                "url": "https://www.pokemon.com/uk/pokedex/lucario"
                            }
                        },
                        {
                            "label": "Venusaur",
                            "value": 100,
                            "source": {
                                "name": "Official Pokedex — Venusaur (standard form)",
                                "url": "https://www.pokemon.com/uk/pokedex/venusaur"
                            }
                        },
                        {
                            "label": "Mewtwo",
                            "value": 122,
                            "source": {
                                "name": "Official Pokedex — Mewtwo (standard form)",
                                "url": "https://www.pokemon.com/uk/pokedex/mewtwo"
                            }
                        }
                    ]
                },
                {
                    "question": "Higher or lower — the calories in one of each of these Greggs items, as Greggs gave them on its own product pages in August 2026.",
                    "answer": "Roughly: Steak Bake 410, Glazed Ring Doughnut 200, Sausage Roll 350, Hot Southern Fried Chicken Baguette 560, Belgian Bun 375, Sausage, Bean & Cheese Melt 455 kcal — so the calls are: lower, higher, higher, lower, higher. (Exact figures are on the Greggs product pages linked against each rung.)",
                    "difficulty": "medium",
                    "topic": "Food and drink",
                    "funFact": "Greggs publishes the calories for every item on its own product pages — and by its own numbers a sausage roll comes out lower than a Belgian bun.",
                    "source": {
                        "name": "Greggs — nutritional information on each product page, linked on each rung",
                        "url": "https://www.greggs.com/menu"
                    },
                    "rungs": [
                        {
                            "label": "A Greggs Steak Bake",
                            "value": 411,
                            "source": {
                                "name": "Greggs — Steak Bake product page",
                                "url": "https://www.greggs.com/menu/product/steak-bake-1000514"
                            }
                        },
                        {
                            "label": "A Greggs Glazed Ring Doughnut",
                            "value": 204,
                            "source": {
                                "name": "Greggs — Glazed Ring Doughnut product page",
                                "url": "https://www.greggs.com/menu/product/glazed-ring-doughnut-1003460"
                            }
                        },
                        {
                            "label": "A Greggs Sausage Roll",
                            "value": 347,
                            "source": {
                                "name": "Greggs — Sausage Roll product page",
                                "url": "https://www.greggs.com/menu/product/sausage-roll-1000446"
                            }
                        },
                        {
                            "label": "A Greggs Hot Southern Fried Chicken Baguette",
                            "value": 557,
                            "source": {
                                "name": "Greggs — Hot Southern Fried Chicken Baguette product page",
                                "url": "https://www.greggs.com/menu/product/hot-southern-fried-chicken-baguette-1000669"
                            }
                        },
                        {
                            "label": "A Greggs Belgian Bun",
                            "value": 374,
                            "source": {
                                "name": "Greggs — Belgian Bun product page",
                                "url": "https://www.greggs.com/menu/product/belgian-bun-1002028"
                            }
                        },
                        {
                            "label": "A Greggs Sausage, Bean & Cheese Melt",
                            "value": 456,
                            "source": {
                                "name": "Greggs — Sausage, Bean & Cheese Melt product page",
                                "url": "https://www.greggs.com/menu/product/sausage-bean-cheese-melt-1000517"
                            }
                        }
                    ]
                },
                {
                    "question": "Higher or lower — the year each of these happened. They are closer together than you think.",
                    "answer": "The sinking of the Titanic 1912, Howard Carter finds Tutankhamun's tomb 1922, the Wright brothers' first powered flight 1903, Alexander Fleming discovers penicillin 1928, the BBC's television service opens at Alexandra Palace 1936, the first FA Cup final at Wembley 1923 — so the calls are: higher, lower, higher, higher, lower.",
                    "difficulty": "hard",
                    "topic": "History",
                    "funFact": "Wembley was designed to hold 127,000 for that first cup final. An estimated 200,000 got in, and the match kicked off 46 minutes late once mounted police had pushed the crowd back off the pitch.",
                    "source": {
                        "name": "Royal Museums Greenwich, the Griffith Institute (Oxford), the US National Park Service, the Science Museum, the National Science and Media Museum and Wembley Stadium — one per rung",
                        "url": "https://www.rmg.co.uk/stories/maritime-history/rms-titanic-facts"
                    },
                    "rungs": [
                        {
                            "label": "The sinking of the Titanic",
                            "value": 1912,
                            "source": {
                                "name": "Royal Museums Greenwich — RMS Titanic facts",
                                "url": "https://www.rmg.co.uk/stories/maritime-history/rms-titanic-facts"
                            }
                        },
                        {
                            "label": "Howard Carter finds the tomb of Tutankhamun",
                            "value": 1922,
                            "source": {
                                "name": "Griffith Institute, University of Oxford — Tutankhamun Spatial Archive: Howard Carter",
                                "url": "https://tutankhamun.griffith.ox.ac.uk/people/howard-carter"
                            }
                        },
                        {
                            "label": "The Wright brothers' first powered flight",
                            "value": 1903,
                            "source": {
                                "name": "US National Park Service — Wright Brothers National Memorial: The First Flight",
                                "url": "https://www.nps.gov/wrbr/learn/historyculture/thefirstflight.htm"
                            }
                        },
                        {
                            "label": "Alexander Fleming discovers penicillin",
                            "value": 1928,
                            "source": {
                                "name": "Science Museum — How was penicillin developed?",
                                "url": "https://www.sciencemuseum.org.uk/objects-and-stories/how-was-penicillin-developed"
                            }
                        },
                        {
                            "label": "The BBC's television service opens at Alexandra Palace",
                            "value": 1936,
                            "source": {
                                "name": "National Science and Media Museum — Launching BBC television",
                                "url": "https://www.scienceandmediamuseum.org.uk/objects-and-stories/who-invented-television"
                            }
                        },
                        {
                            "label": "The first FA Cup final played at Wembley",
                            "value": 1923,
                            "source": {
                                "name": "Wembley Stadium — Wembley's first ever match",
                                "url": "https://www.wembleystadium.com/news/2013/apr/26/the-first-ever-match-at-wembley"
                            }
                        }
                    ]
                },
                {
                    "question": "Higher or lower — how long each film runs in minutes, taking the standard 2D cinema version as timed by the BBFC and rounding to the nearest minute.",
                    "answer": "Harry Potter and the Philosopher's Stone 152, Shrek 90, Barbie 114, Oppenheimer 180, Wicked 160, Inside Out 2 96 — so the calls are: lower, higher, higher, lower, lower.",
                    "difficulty": "hard",
                    "topic": "Film",
                    "funFact": "The BBFC timed the standard 2D cinema version of Wicked at 159 minutes and 59 seconds — one second short of two hours and forty. The IMAX cut of Oppenheimer ran half a minute longer than the ordinary one.",
                    "source": {
                        "name": "BBFC — classification records, one release page per rung",
                        "url": "https://www.bbfc.co.uk/search"
                    },
                    "rungs": [
                        {
                            "label": "Harry Potter and the Philosopher's Stone",
                            "value": 152,
                            "source": {
                                "name": "BBFC — Harry Potter and the Philosopher's Stone (2D cinema: 152m 13s in 2001, 152m 0s on re-release)",
                                "url": "https://www.bbfc.co.uk/release/harry-potter-and-the-philosophers-stone-q29sbgvjdglvbjpwwc0zmzm2odi"
                            }
                        },
                        {
                            "label": "Shrek",
                            "value": 90,
                            "source": {
                                "name": "BBFC — Shrek (2D cinema, 2001: 90m 19s)",
                                "url": "https://www.bbfc.co.uk/release/shrek-q29sbgvjdglvbjpwwc0zndmxnte"
                            }
                        },
                        {
                            "label": "Barbie",
                            "value": 114,
                            "source": {
                                "name": "BBFC — Barbie (2D cinema, 2023: 113m 54s)",
                                "url": "https://www.bbfc.co.uk/release/barbie-q29sbgvjdglvbjpwwc0xmda5otq3"
                            }
                        },
                        {
                            "label": "Oppenheimer",
                            "value": 180,
                            "source": {
                                "name": "BBFC — Oppenheimer (2D cinema, 2023: 180m 9s)",
                                "url": "https://www.bbfc.co.uk/release/oppenheimer-q29sbgvjdglvbjpwwc0xmda2mjm0"
                            }
                        },
                        {
                            "label": "Wicked (the 2024 film, not Wicked: For Good)",
                            "value": 160,
                            "source": {
                                "name": "BBFC — Wicked (2D cinema, 2024: 159m 59s)",
                                "url": "https://www.bbfc.co.uk/release/wicked-q29sbgvjdglvbjpwwc0xmdiwotc4"
                            }
                        },
                        {
                            "label": "Inside Out 2",
                            "value": 96,
                            "source": {
                                "name": "BBFC — Inside Out 2 (2D cinema, 2024: 96m 19s)",
                                "url": "https://www.bbfc.co.uk/release/inside-out-2-q29sbgvjdglvbjpwwc0xmde3njay"
                            }
                        }
                    ]
                }
            ]
        },
        {
            "id": "nobody-else",
            "name": "Nobody Else",
            "icon": "🙈",
            "intro": "Five boards, twelve tiles each. Some tiles belong to the category and some do not. Pick three. Anything another table also picked is void for both of you, so the trick is finding a right answer the other sofa will walk straight past.",
            "format": "nobody-else",
            "questions": [
                {
                    "question": "Which of these are actual mobs in Minecraft? (The main game, not the spin-offs.)",
                    "answer": "Creeper, Warden, Ghast, Sniffer, Enderman, Piglin, Bogged and Allay are all in the game. Moobloom, Glare, Tuff Golem and Rascal each lost a mob vote and have never been built.",
                    "pick": 3,
                    "tiles": [
                        {
                            "label": "Creeper",
                            "correct": true
                        },
                        {
                            "label": "Moobloom",
                            "correct": false
                        },
                        {
                            "label": "Warden",
                            "correct": true
                        },
                        {
                            "label": "Ghast",
                            "correct": true
                        },
                        {
                            "label": "Glare",
                            "correct": false
                        },
                        {
                            "label": "Sniffer",
                            "correct": true
                        },
                        {
                            "label": "Enderman",
                            "correct": true
                        },
                        {
                            "label": "Tuff Golem",
                            "correct": false
                        },
                        {
                            "label": "Piglin",
                            "correct": true
                        },
                        {
                            "label": "Bogged",
                            "correct": true
                        },
                        {
                            "label": "Rascal",
                            "correct": false
                        },
                        {
                            "label": "Allay",
                            "correct": true
                        }
                    ],
                    "difficulty": "easy",
                    "topic": "Gaming",
                    "funFact": "Every fake here lost one of Mojang's public mob votes, though losing need not be final: the copper golem was finally built in 2025, four years after it lost one.",
                    "source": {
                        "name": "Minecraft Wiki — Mob Vote",
                        "url": "https://minecraft.wiki/w/Mob_Vote"
                    }
                },
                {
                    "question": "Which of these are London Underground stations, meaning somewhere a tube line actually calls?",
                    "answer": "Elephant & Castle, Theydon Bois, Burnt Oak, Mornington Crescent, Gants Hill, Chalfont & Latimer, Wembley Park and Roding Valley are all served by a tube line. Clapham Junction, Crouch End, Muswell Hill and Camberwell are not.",
                    "pick": 3,
                    "tiles": [
                        {
                            "label": "Elephant & Castle",
                            "correct": true
                        },
                        {
                            "label": "Clapham Junction",
                            "correct": false
                        },
                        {
                            "label": "Theydon Bois",
                            "correct": true
                        },
                        {
                            "label": "Burnt Oak",
                            "correct": true
                        },
                        {
                            "label": "Crouch End",
                            "correct": false
                        },
                        {
                            "label": "Mornington Crescent",
                            "correct": true
                        },
                        {
                            "label": "Gants Hill",
                            "correct": true
                        },
                        {
                            "label": "Muswell Hill",
                            "correct": false
                        },
                        {
                            "label": "Chalfont & Latimer",
                            "correct": true
                        },
                        {
                            "label": "Wembley Park",
                            "correct": true
                        },
                        {
                            "label": "Camberwell",
                            "correct": false
                        },
                        {
                            "label": "Roding Valley",
                            "correct": true
                        }
                    ],
                    "difficulty": "hard",
                    "topic": "London",
                    "funFact": "Eleven tube lines serve 272 stations between them, and for all its platforms and all its trains, Clapham Junction has never been one of them.",
                    "source": {
                        "name": "Wikipedia — List of London Underground stations",
                        "url": "https://en.wikipedia.org/wiki/List_of_London_Underground_stations"
                    }
                },
                {
                    "question": "Which of these countries won the Eurovision Song Contest between 2000 and 2025?",
                    "answer": "Sweden, Ukraine, the Netherlands, Portugal, Finland, Israel, Latvia and Azerbaijan all won in that window. Ireland, the United Kingdom, Iceland and Malta did not.",
                    "pick": 3,
                    "tiles": [
                        {
                            "label": "Sweden",
                            "correct": true
                        },
                        {
                            "label": "Ireland",
                            "correct": false
                        },
                        {
                            "label": "Ukraine",
                            "correct": true
                        },
                        {
                            "label": "Netherlands",
                            "correct": true
                        },
                        {
                            "label": "United Kingdom",
                            "correct": false
                        },
                        {
                            "label": "Portugal",
                            "correct": true
                        },
                        {
                            "label": "Finland",
                            "correct": true
                        },
                        {
                            "label": "Iceland",
                            "correct": false
                        },
                        {
                            "label": "Israel",
                            "correct": true
                        },
                        {
                            "label": "Latvia",
                            "correct": true
                        },
                        {
                            "label": "Malta",
                            "correct": false
                        },
                        {
                            "label": "Azerbaijan",
                            "correct": true
                        }
                    ],
                    "difficulty": "medium",
                    "topic": "Music",
                    "funFact": "Ireland and Sweden share the record at seven wins each, but every Irish win came before 2000, and Malta has twice finished second this century without ever winning.",
                    "source": {
                        "name": "Wikipedia — List of Eurovision Song Contest winners",
                        "url": "https://en.wikipedia.org/wiki/List_of_Eurovision_Song_Contest_winners"
                    }
                },
                {
                    "question": "Which of these were medal sports at the Paris 2024 Olympics?",
                    "answer": "Skateboarding, breaking, handball, rugby sevens, 3x3 basketball, surfing, modern pentathlon and canoe slalom were all on the Paris programme. Karate, squash, cricket and baseball were not.",
                    "pick": 3,
                    "tiles": [
                        {
                            "label": "Skateboarding",
                            "correct": true
                        },
                        {
                            "label": "Karate",
                            "correct": false
                        },
                        {
                            "label": "Breaking",
                            "correct": true
                        },
                        {
                            "label": "Handball",
                            "correct": true
                        },
                        {
                            "label": "Squash",
                            "correct": false
                        },
                        {
                            "label": "Rugby Sevens",
                            "correct": true
                        },
                        {
                            "label": "3x3 Basketball",
                            "correct": true
                        },
                        {
                            "label": "Cricket",
                            "correct": false
                        },
                        {
                            "label": "Surfing",
                            "correct": true
                        },
                        {
                            "label": "Modern Pentathlon",
                            "correct": true
                        },
                        {
                            "label": "Baseball",
                            "correct": false
                        },
                        {
                            "label": "Canoe Slalom",
                            "correct": true
                        }
                    ],
                    "difficulty": "medium",
                    "topic": "Sport",
                    "funFact": "Paris gave out medals in 329 events and held its surfing in Tahiti, 15,715 km away, reckoned the furthest an Olympic venue has ever sat from the host city.",
                    "source": {
                        "name": "Olympedia — 2024 Summer Olympics, Paris",
                        "url": "https://www.olympedia.org/editions/63"
                    }
                },
                {
                    "question": "Which of these are one of the Seven Wonders of the Ancient World?",
                    "answer": "The Pyramids of Giza, the Hanging Gardens, the Colossus of Rhodes, the Temple of Artemis, the Statue of Zeus, the lighthouse at Alexandria and the Mausoleum at Halicarnassus. The Colosseum, Stonehenge, the Great Wall, Petra and Machu Picchu are not on the ancient list.",
                    "pick": 3,
                    "tiles": [
                        {
                            "label": "Pyramids of Giza",
                            "correct": true
                        },
                        {
                            "label": "Colosseum",
                            "correct": false
                        },
                        {
                            "label": "Hanging Gardens",
                            "correct": true
                        },
                        {
                            "label": "Colossus of Rhodes",
                            "correct": true
                        },
                        {
                            "label": "Stonehenge",
                            "correct": false
                        },
                        {
                            "label": "Temple of Artemis",
                            "correct": true
                        },
                        {
                            "label": "Statue of Zeus",
                            "correct": true
                        },
                        {
                            "label": "The Great Wall",
                            "correct": false
                        },
                        {
                            "label": "Alexandria Lighthouse",
                            "correct": true
                        },
                        {
                            "label": "Halicarnassus Mausoleum",
                            "correct": true
                        },
                        {
                            "label": "Petra",
                            "correct": false
                        },
                        {
                            "label": "Machu Picchu",
                            "correct": false
                        }
                    ],
                    "difficulty": "medium",
                    "topic": "History",
                    "funFact": "The pyramids at Giza are the oldest of the seven and the only one substantially standing today; the other six survive only in ancient descriptions.",
                    "source": {
                        "name": "Britannica — Seven Wonders of the World",
                        "url": "https://www.britannica.com/topic/Seven-Wonders-of-the-World"
                    }
                }
            ]
        }
    ]
};

/*
 * PLACEHOLDER — replaced by the verified 60-question pack once research completes.
 */
export default {
    id: 'slop-classic-01',
    name: 'The Slop Classic',
    description: 'Placeholder pack.',
    version: 1,
    rounds: [
        {
            id: 'general-knowledge',
            name: 'General Knowledge',
            icon: '🌍',
            intro: 'We start gently.',
            questions: [
                {
                    question: 'What is the capital city of Wales?',
                    answer: 'Cardiff',
                    acceptable: ['Caerdydd'],
                    difficulty: 'easy',
                    topic: 'Geography',
                    funFact: 'Cardiff was only made the capital of Wales in 1955.',
                    source: { name: 'Placeholder', url: 'https://example.org/' },
                },
                {
                    question: 'Which river flows through the middle of London?',
                    answer: 'The Thames',
                    acceptable: ['Thames'],
                    difficulty: 'easy',
                    topic: 'Geography',
                    funFact: 'The Thames is the longest river entirely in England.',
                    source: { name: 'Placeholder', url: 'https://example.org/' },
                },
            ],
        },
        {
            id: 'music',
            name: 'Music',
            icon: '🎵',
            intro: 'Ears open.',
            questions: [
                {
                    question: 'Listen to this famous theme. Which composer wrote it?',
                    answer: 'Beethoven',
                    acceptable: ['Ludwig van Beethoven'],
                    difficulty: 'medium',
                    topic: 'Classical',
                    funFact: 'Beethoven was almost totally deaf by the time of his ninth symphony.',
                    melody: 'odeToJoy',
                    source: { name: 'Placeholder', url: 'https://example.org/' },
                },
                {
                    question: 'Which Liverpool band released the album Abbey Road?',
                    answer: 'The Beatles',
                    acceptable: ['Beatles'],
                    difficulty: 'easy',
                    topic: 'Pop',
                    funFact: 'Abbey Road was the last album the four of them recorded together.',
                    source: { name: 'Placeholder', url: 'https://example.org/' },
                },
            ],
        },
    ],
    tiebreaker: {
        question: 'How many steps are there to the top of the Eiffel Tower?',
        answer: 1665,
        unit: 'steps',
        funFact: 'Placeholder.',
        source: { name: 'Placeholder', url: 'https://example.org/' },
    },
};

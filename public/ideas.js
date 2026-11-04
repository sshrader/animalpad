/* Random animal ideas for the example buttons. Each idea mixes a mood, an animal and an extra,
   so there are thousands of combinations instead of three fixed ones. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AnimalIdeas = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MOODS = ['tired', 'angry', 'sleepy', 'smug', 'nervous', 'heroic', 'dramatic', 'confused', 'fancy', 'grumpy', 'cheerful', 'suspicious', 'sad', 'proud', 'chaotic', 'chill'];
  const ANIMALS = ['heron', 'capybara', 'red panda', 'frog', 'axolotl', 'otter', 'pigeon', 'hedgehog', 'llama', 'octopus', 'sloth', 'penguin', 'crab', 'goat', 'raccoon', 'moth', 'walrus', 'flamingo', 'hamster', 'narwhal', 'bat', 'snail', 'duck', 'ferret', 'owl', 'tortoise', 'seal', 'badger'];
  const EXTRAS = ['wearing a tiny crown', 'in sunglasses', 'on a skateboard', 'eating a donut', 'holding an umbrella', 'riding a bike', 'wearing a wizard hat', 'drinking coffee', 'with a cape', 'in a space helmet', 'carrying a tiny briefcase', 'playing guitar', 'in a raincoat', 'wearing a scarf', 'eating a slice of pizza', 'holding a balloon', 'wearing headphones', 'in a bathtub'];

  const pick = (list, rand) => list[Math.floor(rand() * list.length)];
  const article = word => (/^[aeiou]/i.test(word) ? 'an' : 'a');

  function one(rand) {
    const mood = pick(MOODS, rand);
    return article(mood) + ' ' + mood + ' ' + pick(ANIMALS, rand) + ' ' + pick(EXTRAS, rand);
  }

  // n different ideas.
  function ideas(n, rand) {
    const r = typeof rand === 'function' ? rand : Math.random;
    const out = [];
    let guard = 0;
    while (out.length < n && guard++ < 200) {
      const idea = one(r);
      if (out.indexOf(idea) === -1) out.push(idea);
    }
    return out;
  }

  return { ideas, MOODS, ANIMALS, EXTRAS };
});

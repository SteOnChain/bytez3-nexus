chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const { action } = request;

  if (action === 'snapshot') {
    // Generate a simple view of the page
    const text = document.body.innerText.substring(0, 5000);
    // Find clickable elements
    const clickables = Array.from(document.querySelectorAll('a, button, input, [role="button"]'))
      .filter(el => el.offsetParent !== null) // is visible
      .map((el, index) => {
        el.setAttribute('data-agent-id', index);
        const rect = el.getBoundingClientRect();
        return {
          id: index,
          tag: el.tagName,
          text: (el.innerText || el.value || el.placeholder || '').substring(0, 30).trim(),
          type: el.type || '',
          x: Math.round(rect.x),
          y: Math.round(rect.y)
        };
      })
      .filter(c => c.text || c.type); // only keep things we can identify

    sendResponse({ 
      result: {
         url: window.location.href,
         textContext: text,
         clickables: clickables
      }
    });
    return true;
  }

  if (action === 'click') {
    const { selector, index } = request;
    let target = null;
    if (index !== undefined) {
      target = document.querySelector(`[data-agent-id="${index}"]`);
    } else if (selector) {
      target = document.querySelector(selector);
    }

    if (target) {
      target.scrollIntoView({ behavior: 'instant', block: 'center' });
      target.click();
      sendResponse({ result: 'Clicked successfully' });
    } else {
      sendResponse({ error: 'Target element not found' });
    }
    return true;
  }

  if (action === 'type') {
    const { selector, index, text } = request;
    let target = null;
    if (index !== undefined) {
      target = document.querySelector(`[data-agent-id="${index}"]`);
    } else if (selector) {
      target = document.querySelector(selector);
    }

    if (target) {
      target.scrollIntoView({ behavior: 'instant', block: 'center' });
      target.focus();
      
      // Simulate typing event by event
      const chars = text.split('');
      target.value = ''; // clear first
      
      chars.forEach((char, i) => {
          // just set value and dispatch input
          target.value += char;
          target.dispatchEvent(new Event('input', { bubbles: true }));
      });
      target.dispatchEvent(new Event('change', { bubbles: true }));
      
      sendResponse({ result: 'Typed successfully' });
    } else {
      sendResponse({ error: 'Target element not found' });
    }
    return true;
  }
});

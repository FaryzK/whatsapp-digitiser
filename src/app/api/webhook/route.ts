import { NextResponse } from 'next/server';
import twilio from 'twilio';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import OpenAI from 'openai';

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Initialize Redis for rate limiting
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || '',
  token: process.env.UPSTASH_REDIS_REST_TOKEN || '',
});

// Create rate limiter - updating to 30 requests per hour per phone number
const ratelimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(30, '1 h'),
});

// Update the validateRequest function
const validateRequest = (request: Request, twilioSignature: string | null) => {
  // During development/testing, we can bypass signature validation
  if (process.env.NODE_ENV === 'development') {
    return true;
  }

  const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
  const url = request.url;
  const params = Object.fromEntries(new URL(url).searchParams);

  return twilio.validateRequest(
    twilioAuthToken,
    twilioSignature || '',
    url,
    params
  );
};

// Add this helper function
function cleanMarkdownForWhatsApp(text: string): string {
  return text
    // Remove markdown headers (###, ##, #)
    .replace(/^#{1,6}\s/gm, '')
    // Remove duplicate asterisks while preserving WhatsApp formatting
    .replace(/\*{4}/g, '*')
    .replace(/\*{3}/g, '*')
    .replace(/\*{2}/g, '*')
    // Remove markdown list markers
    .replace(/^[-*+]\s/gm, '')
    .replace(/^\d+\.\s/gm, '')
    // Remove code blocks and backticks
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    // Remove horizontal rules
    .replace(/^[-*_]{3,}\s*$/gm, '')
    // Clean up extra newlines
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Add this helper function to split long messages
function splitIntoWhatsAppMessages(text: string, maxLength: number = 1500): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const messages: string[] = [];
  let currentMessage = '';
  const paragraphs = text.split('\n\n');

  for (const paragraph of paragraphs) {
    if ((currentMessage + paragraph).length > maxLength) {
      if (currentMessage) {
        messages.push(currentMessage.trim());
        currentMessage = '';
      }
      // If a single paragraph is too long, split it by sentences
      if (paragraph.length > maxLength) {
        const sentences = paragraph.match(/[^.!?]+[.!?]+/g) || [paragraph];
        for (const sentence of sentences) {
          if (currentMessage.length + sentence.length > maxLength) {
            messages.push(currentMessage.trim());
            currentMessage = sentence;
          } else {
            currentMessage += sentence;
          }
        }
      } else {
        currentMessage = paragraph;
      }
    } else {
      currentMessage += (currentMessage ? '\n\n' : '') + paragraph;
    }
  }

  if (currentMessage) {
    messages.push(currentMessage.trim());
  }

  // Add message numbering if there are multiple messages
  return messages.length > 1 
    ? messages.map((msg, i) => `*Part ${i + 1}/${messages.length}*\n\n${msg}`)
    : messages;
}

export async function POST(request: Request) {
  try {
    console.log('Received webhook request'); // Add logging

    const formData = await request.formData();
    const from = formData.get('From') as string;
    const body = formData.get('Body') as string;
    
    console.log('Message from:', from); // Add logging
    console.log('Message body:', body); // Add logging

    // If there's no media, just respond to the text message
    if (!formData.get('MediaUrl0')) {
      return sendWhatsAppMessage(
        from,
        'Hello! Please send an image to digitize its content.'
      );
    }

    // Apply rate limiting
    const { success, reset } = await ratelimit.limit(from);
    if (!success) {
      const resetDate = new Date(reset);
      return sendWhatsAppMessage(
        from,
        `You've reached the limit of requests. Please try again after ${resetDate.toLocaleTimeString()}.`
      );
    }

    // Get the image content and handle the format
    const mediaUrl = formData.get('MediaUrl0') as string;
    console.log('Media URL:', mediaUrl);

    // Create Twilio client for media handling
    const client = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );

    // Extract the Media SID from the URL
    const mediaSid = mediaUrl.split('/Media/')[1];
    console.log('Media SID:', mediaSid);

    // Get the media resource
    const media = await client.messages(formData.get('MessageSid') as string)
      .media(mediaSid)
      .fetch();
    
    // Get the actual content URL
    const contentUrl = media.uri.replace('.json', '');
    console.log('Content URL:', contentUrl);

    // Fetch the actual image
    const imageResponse = await fetch(`https://api.twilio.com${contentUrl}`, {
      headers: {
        Authorization: `Basic ${Buffer.from(
          `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
        ).toString('base64')}`,
      },
    });

    const contentType = imageResponse.headers.get('content-type');
    console.log('Content Type:', contentType);

    // Ensure we have a valid image type
    if (!contentType || !contentType.startsWith('image/')) {
      return sendWhatsAppMessage(
        from,
        'Please send a valid image file (JPEG, PNG, GIF, or WEBP).'
      );
    }

    const imageBuffer = await imageResponse.arrayBuffer();
    const imageBase64 = Buffer.from(imageBuffer).toString('base64');
    console.log('Image size:', imageBuffer.byteLength); // Add logging for image size

    // Process image with OpenAI Vision
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: [
            { 
              type: "text", 
              text: "Please extract and structure all the text content from this image. Format the response using WhatsApp formatting: use *asterisks* for bold text, _underscores_ for italics, and ~tildes~ for strikethrough. Avoid using markdown headers, bullet points, or other special formatting. Be concise but thorough." 
            },
            {
              type: "image_url",
              image_url: {
                url: `data:${contentType};base64,${imageBase64}`,
              },
            },
          ],
        },
      ],
      max_tokens: 500,
    });

    const extractedText = completion.choices[0].message.content;

    // Send the response back via WhatsApp (no need for cleaning since format is correct)
    return sendWhatsAppMessage(from, extractedText || 'No text could be extracted from the image.');

  } catch (error) {
    console.error('Error processing request:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// Update the sendWhatsAppMessage function to handle message arrays
async function sendWhatsAppMessage(to: string, message: string) {
  const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );

  console.log('Sending message to:', to);
  
  const messages = splitIntoWhatsAppMessages(message);
  console.log(`Splitting into ${messages.length} messages`);

  try {
    // Send messages sequentially
    for (const msgContent of messages) {
      console.log('Sending message part, length:', msgContent.length);
      await client.messages.create({
        from: `whatsapp:${process.env.TWILIO_PHONE_NUMBER}`,
        to: to,
        body: msgContent,
      });
      
      // Add a small delay between messages if sending multiple
      if (messages.length > 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error sending message:', error);
    return NextResponse.json({ error: 'Failed to send message' }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return new Response('Webhook endpoint is active');
}
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
    console.log('🔵 Received webhook request');

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error('Processing timeout - request took too long'));
      }, 8000);
    });

    const processImagePromise = async () => {
      const formData = await request.formData();
      const from = formData.get('From') as string;
      const body = formData.get('Body') as string;
      
      console.log('📱 Message from:', from);
      console.log('📝 Message body:', body);

      if (!formData.get('MediaUrl0')) {
        console.log('❌ No media received');
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
      console.log('🖼️ Media URL:', mediaUrl);

      try {
        // Create Twilio client for media handling
        const client = twilio(
          process.env.TWILIO_ACCOUNT_SID,
          process.env.TWILIO_AUTH_TOKEN
        );

        // Extract the Media SID from the URL
        const mediaSid = mediaUrl.split('/Media/')[1];
        console.log('🆔 Media SID:', mediaSid);

        // Get the media resource
        const media = await client.messages(formData.get('MessageSid') as string)
          .media(mediaSid)
          .fetch();
        
        // Get the actual content URL
        const contentUrl = media.uri.replace('.json', '');
        console.log('🔗 Content URL:', contentUrl);

        // Fetch the actual image
        const imageResponse = await fetch(`https://api.twilio.com${contentUrl}`, {
          headers: {
            Authorization: `Basic ${Buffer.from(
              `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
            ).toString('base64')}`,
          },
        });

        const contentType = imageResponse.headers.get('content-type');
        console.log('📋 Content Type:', contentType);

        if (!contentType || !contentType.startsWith('image/')) {
          console.log('❌ Invalid content type:', contentType);
          return sendWhatsAppMessage(
            from,
            'Please send a valid image file (JPEG, PNG, GIF, or WEBP).'
          );
        }

        const imageBuffer = await imageResponse.arrayBuffer();
        console.log('📊 Image size:', {
          bytes: imageBuffer.byteLength,
          megabytes: (imageBuffer.byteLength / (1024 * 1024)).toFixed(2) + 'MB'
        });

        // Add size check
        if (imageBuffer.byteLength > 20 * 1024 * 1024) { // 20MB limit
          console.log('❌ Image too large');
          return sendWhatsAppMessage(
            from,
            'The image is too large. Please send an image smaller than 20MB.'
          );
        }

        const imageBase64 = Buffer.from(imageBuffer).toString('base64');

        // Add a timeout specifically for OpenAI request
        const openAiPromise = openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Please extract and structure all the text content from this image..." },
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

        console.log('🤖 Sending to OpenAI...');
        
        const completion = await Promise.race([
          openAiPromise,
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error('OpenAI API timeout')), 7000);
          })
        ]) as OpenAI.Chat.ChatCompletion;

        console.log('✅ OpenAI response received');
        const extractedText = completion?.choices[0]?.message?.content;
        
        if (!extractedText) {
          console.log('⚠️ No text extracted from image');
        } else {
          console.log('📝 Extracted text length:', extractedText.length);
        }

        return sendWhatsAppMessage(from, extractedText || 'No text could be extracted from the image.');

      } catch (error: any) {
        console.error('🔴 Error processing image:', error);
        
        let errorMessage = 'Sorry, there was an error processing your image. Please try again with a different image.';
        if (error?.message === 'OpenAI API timeout') {
          errorMessage = 'Processing took too long for our sandbox. Please try again with a clearer or smaller image.';
        }
        
        return sendWhatsAppMessage(from, errorMessage);
      }
    };

    // Race between the main process and the timeout
    return await Promise.race([processImagePromise(), timeoutPromise]);

  } catch (error: any) {
    console.error('🔴 Error processing request:', error);
    
    let statusCode = 500;
    let errorMessage = 'Internal server error';
    
    if (error?.message === 'Processing timeout - request took too long') {
      statusCode = 504;
      errorMessage = 'Processing took too long for our sandbox. Please try again with a clearer or smaller image.';
    }
    
    return NextResponse.json(
      { error: errorMessage },
      { status: statusCode }
    );
  }
}

// Update sendWhatsAppMessage with better logging
async function sendWhatsAppMessage(to: string, message: string) {
  const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );

  console.log('📤 Sending message to:', to);
  
  const messages = splitIntoWhatsAppMessages(message);
  console.log(`📬 Splitting into ${messages.length} messages`);

  try {
    for (const msgContent of messages) {
      console.log('📨 Sending message part, length:', msgContent.length);
      await client.messages.create({
        from: `whatsapp:${process.env.TWILIO_PHONE_NUMBER}`,
        to: to,
        body: msgContent,
      });
      
      if (messages.length > 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    console.log('✅ All messages sent successfully');
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('🔴 Error sending message:', error);
    return NextResponse.json({ error: 'Failed to send message' }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return new Response('Webhook endpoint is active');
}
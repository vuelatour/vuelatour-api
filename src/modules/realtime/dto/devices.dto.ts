import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, MinLength } from 'class-validator';

export class RegisterDeviceDto {
  @ApiProperty({ description: 'Token FCM/APNs del dispositivo' })
  @IsString()
  @MinLength(10)
  token!: string;

  @ApiProperty({ enum: ['android', 'ios', 'web'] })
  @IsIn(['android', 'ios', 'web'])
  plataforma!: 'android' | 'ios' | 'web';
}

export class UnregisterDeviceDto {
  @ApiProperty({ description: 'Token a dar de baja' })
  @IsString()
  @MinLength(10)
  token!: string;
}

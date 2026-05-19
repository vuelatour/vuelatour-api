import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class ListCardsQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  usuario_id?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  activa?: boolean;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 50;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;
}

export class CreateCardDto {
  @ApiProperty({ description: 'Últimos 4 dígitos', example: '6256' })
  @IsString()
  @Length(4, 4)
  @Matches(/^\d{4}$/, { message: 'terminacion must be 4 digits' })
  terminacion!: string;

  @ApiProperty({ maxLength: 100 })
  @IsString()
  @MaxLength(100)
  nombre_titular!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  usuario_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  banco?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  cuenta_bancaria_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;
}

export class UpdateCardDto extends PartialType(CreateCardDto) {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  activa?: boolean;
}

export class LinkCardUserDto {
  @ApiProperty({
    description: 'Usuario id a vincular (null para desvincular)',
    nullable: true,
  })
  @IsOptional()
  @IsUUID()
  usuario_id?: string | null;
}
